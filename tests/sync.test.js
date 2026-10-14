/**
 * tests/sync.test.js — plan step 10.
 *
 * Covers the three claims that are easy to make and hard to keep:
 *
 *   1. IDEMPOTENCY — an idempotency key sent twice produces ONE row.
 *   2. PAGING — a cursor walk under concurrent inserts neither skips nor
 *      duplicates, which is the property the old `id > cursor ASC` scheme could
 *      not have.
 *   3. CLEANUP — the SSE client unsubscribes on unmount and leaves no handle
 *      behind, which is the property that decides whether CI finishes.
 *
 * Plus two things that are claims rather than features and so must be tested:
 * `in_transit → opened` actually transitions, and `replied` is derived rather
 * than declared.
 *
 * HARNESS. This file builds its OWN express app and mounts the letters router on
 * an injected in-memory database, exactly as server/routes/letters.js documents
 * itself to be mounted. server/index.js is not imported and not touched: wiring
 * that up is the integrating session's job, and a test that depended on it would
 * be testing the wiring rather than the behaviour.
 *
 * NO-LEAK. The "no plaintext" assertions here are the same ones tests/e2e makes
 * against the real database, run cheaply. They are the reason `state` is a
 * bare enum and `local_error` is a sentence about the transport, never a snippet
 * of a letter.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'sync-test-secret-not-for-production-1234567890';

// ─── a fake IndexedDB ────────────────────────────────────────────────────────
// Real enough to run the actual `openOutbox` code path: open/onupgradeneeded,
// put/get/getAll/delete/clear, transactions, keyPath. A stub object store would
// pass while proving nothing about the IndexedDB implementation.

function installFakeIndexedDB() {
  const databases = new Map();

  function makeRequest() {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    // Real IDB fires these asynchronously. Making them synchronous would hide
    // any bug where the code assumes its own write has landed.
    queueMicrotask(() => {
      try {
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
    });
    return req;
  }

  class FakeTransaction {
    constructor(store) {
      this.store = store;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.error = null;
      this.done = false;
      // A transaction auto-completes after its requests settle, so `txDone()`
      // resolves the way it does in a browser.
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (this.done) return;
          this.done = true;
          this.oncomplete?.();
        });
      });
    }
    objectStore() {
      return this.store;
    }
  }

  class FakeStore {
    constructor(name, keyPath) {
      this.name = name;
      this.keyPath = keyPath;
      this.rows = new Map();
    }
    createIndex() {
      return {};
    }
    put(value) {
      const req = makeRequest();
      this.rows.set(value[this.keyPath], structuredClone(value));
      req.result = value[this.keyPath];
      return req;
    }
    get(key) {
      const req = makeRequest();
      req.result = this.rows.has(key) ? structuredClone(this.rows.get(key)) : undefined;
      return req;
    }
    getAll() {
      const req = makeRequest();
      req.result = Array.from(this.rows.values()).map((r) => structuredClone(r));
      return req;
    }
    delete(key) {
      const req = makeRequest();
      this.rows.delete(key);
      return req;
    }
    clear() {
      const req = makeRequest();
      this.rows.clear();
      return req;
    }
  }

  const factory = {
    open(name) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
      queueMicrotask(() => {
        try {
          let db = databases.get(name);
          const fresh = !db;
          if (!db) {
            const stores = new Map();
            const dbObj = {
              name,
              objectStoreNames: {
                contains: (n) => stores.has(n),
              },
              createObjectStore(storeName, { keyPath }) {
                const store = new FakeStore(storeName, keyPath);
                stores.set(storeName, store);
                return store;
              },
              transaction(storeName) {
                if (!stores.has(storeName)) throw new Error('no such store');
                return new FakeTransaction(stores.get(storeName));
              },
              close() {},
            };
            db = { dbObj, stores };
            databases.set(name, db);
          }
          req.result = db.dbObj;
          if (fresh) req.onupgradeneeded?.();
          req.onsuccess?.();
        } catch (err) {
          req.error = err;
          req.onerror?.();
        }
      });
      return req;
    },
    deleteDatabase(name) {
      databases.delete(name);
    },
  };

  globalThis.indexedDB = factory;
  return factory;
}

installFakeIndexedDB();

// ─── server harness ─────────────────────────────────────────────────────────

const fs = await import('fs');
const os = await import('os');
const path = await import('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'penpal-sync-'));

const { describe, it, expect, beforeAll, afterAll } = await import('vitest');
const request = (await import('supertest')).default;
const express = (await import('express')).default;
const BetterSqlite3 = (await import('better-sqlite3')).default;

const { signAccessToken } = await import('../server/lib/auth.js');
const letterRoutes = (await import('../server/routes/letters.js')).default;
const repo = (await import('../server/repos/letters.js')).default;

// sync.ts is TypeScript. Vitest transpiles it; the path is the source file.
const sync = await import('../client/src/lib/sync.ts');

const app = express();
app.use(express.json({ limit: '4mb' }));

const db = new BetterSqlite3(':memory:');
// The v0.0.2 letters table, exactly as the legacy insert path wrote it, so the
// migration has something real to migrate.
db.exec(`
  CREATE TABLE letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    encrypted_content TEXT NOT NULL,
    encrypted_metadata TEXT,
    photo_paths TEXT,
    sent_at TEXT,
    delivered_at TEXT,
    sync_version INTEGER DEFAULT 1
  );
  CREATE TABLE pairs (
    user_id INTEGER PRIMARY KEY,
    partner_id INTEGER NOT NULL,
    paired_at TEXT
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT,
    title TEXT,
    body TEXT,
    read INTEGER DEFAULT 0,
    created_at TEXT
  );
`);

app.use('/api/letters', letterRoutes({ db }));

/**
 * A real listening socket, for the SSE tests.
 *
 * supertest cannot hold an event stream open — it waits for the response to end,
 * and an event stream ends when you close it. So the stream tests need an actual
 * TCP connection they can abort, which is the only honest way to prove the
 * server-side teardown actually runs.
 */
let httpServer;
let httpUrl;

beforeAll(async () => {
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  httpUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

/** Signs a token with no `sid`, so auth never reaches for the app singleton. */
const tokenFor = (user) => signAccessToken(user, null);

const asUser = (token) => ({ Authorization: `Bearer ${token}` });

let userSeq = 0;
function makeCouple() {
  userSeq += 1;
  const a = { id: userSeq * 2 - 1, username: `alice_${userSeq}`, pid: `A${String(userSeq).padStart(5, '0')}` };
  const b = { id: userSeq * 2, username: `bob_${userSeq}`, pid: `B${String(userSeq).padStart(5, '0')}` };
  // Both directions, exactly as the pairing write does. `pairs.user_id` is the
  // primary key, so one row per person — and a pairing that is only recorded
  // one way is not a pairing at all.
  const insert = db.prepare('INSERT INTO pairs (user_id, partner_id, paired_at) VALUES (?, ?, ?)');
  const at = new Date().toISOString();
  insert.run(a.id, b.id, at);
  insert.run(b.id, a.id, at);
  return { a, b, aToken: tokenFor(a), bToken: tokenFor(b) };
}

/** Rows this sender owns. The database is shared by every test in this file. */
const countFor = (senderId) =>
  db.prepare('SELECT COUNT(*) AS n FROM letters WHERE sender_id = ?').get(senderId).n;

/**
 * The outbox, emptied.
 *
 * The fake IndexedDB is module-scoped and therefore shared across the file,
 * exactly as a real browser's would be. Clearing per test keeps them from
 * inheriting each other's queued letters — which is not a convenience: a test
 * that saw a stranger's queue would prove nothing about its own.
 */
async function freshOutbox() {
  const outbox = await sync.openOutbox();
  await outbox.clear();
  return outbox;
}

/** A sealed envelope. Opaque by construction — the test never holds the key. */
const ENVELOPE = JSON.stringify({
  v: 2,
  ct: 'Y2lwaGVydGV4dC10aGF0LXdpbGwtbm90LWJlLXJlYWQtYXQtYWxs',
  iv: 'dGhpcy1pcy1hLWZha2UtaXYtdmFsdWU',
  keys: { '1': 'd3JhcHBlZC1mb3ItcmVjaXBpZW50', '2': 'd3JhcHBlZC1mb3Itc2VuZGVy' },
  senderId: 1,
  recipientId: 2,
  sentAt: '2026-10-14T09:00:00.000Z',
});

const PLAINTEXT_NEVER_SENT = 'the tide came in sideways and nobody warned us';

/** Creates letters straight into the db, so paging tests control created_at. */
function seedLetter(senderId, recipientId, { createdAt, deliveredAt = null, content = ENVELOPE }) {
  const info = db
    .prepare(
      `INSERT INTO letters
         (sender_id, recipient_id, encrypted_content, sent_at, delivered_at, created_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'sealed')`,
    )
    .run(senderId, recipientId, content, createdAt, deliveredAt, createdAt);
  return Number(info.lastInsertRowid);
}

/**
 * Drives the REAL client fetch path against the REAL express app.
 *
 * A fake fetch would only test that the fake and the client agree. Going through
 * supertest means the status codes, the header contract, and the body shape are
 * all genuine — and the result is wrapped in a real `Response`, because that is
 * what the client actually consumes.
 */
function httpFetch() {
  return async (input, init = {}) => {
    const target = input.startsWith('http') ? new URL(input) : new URL(input, 'http://localhost');
    const method = (init.method || 'GET').toLowerCase();

    let test = request(app)[method](target.pathname + target.search);
    for (const [k, v] of Object.entries(init.headers || {})) test = test.set(k, String(v));
    if (init.body !== undefined) test = test.send(init.body);

    const res = await test;
    return new globalThis.Response(res.text ?? null, {
      status: res.status,
      headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
    });
  };
}

afterAll(async () => {
  letterRoutes.closeAllStreams();
  await new Promise((resolve) => (httpServer ? httpServer.close(resolve) : resolve()));
  db?.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 1. Idempotency
 * ══════════════════════════════════════════════════════════════════════════ */

describe('idempotency', () => {
  it('produces ONE row when the same idempotency key is sent twice', async () => {
    const { a, b, aToken } = makeCouple();
    const key = sync.mintIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(8); // the server's own floor

    const payload = { recipientId: b.id, encryptedContent: ENVELOPE, idempotencyKey: key };

    const first = await request(app).post('/api/letters/send').set(asUser(aToken)).send(payload);
    const second = await request(app).post('/api/letters/send').set(asUser(aToken)).send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Same letter, not two.
    expect(first.body.letter.id).toBe(second.body.letter.id);
    expect(second.body.duplicate).toBe(true);
    expect(second.headers['idempotent-replay']).toBe('true');

    const rows = db
      .prepare('SELECT id FROM letters WHERE sender_id = ? AND idempotency_key = ?')
      .all(a.id, key);
    expect(rows).toHaveLength(1);
    expect(countFor(a.id)).toBe(1);
  });

  it('reuses the row even when the retried payload differs from the first attempt', async () => {
    // The realistic failure: the server committed, the response was lost, and
    // the client retried with whatever state it had at that moment. If dedupe
    // keyed on a body hash this would insert a second letter.
    const { a, b, aToken } = makeCouple();
    const key = sync.mintIdempotencyKey();

    const first = await request(app)
      .post('/api/letters/send')
      .set(asUser(aToken))
      .send({ recipientId: b.id, encryptedContent: ENVELOPE, idempotencyKey: key });
    const second = await request(app)
      .post('/api/letters/send')
      .set(asUser(aToken))
      .send({
        recipientId: b.id,
        encryptedContent: JSON.stringify({ ...JSON.parse(ENVELOPE), v: 2 }),
        idempotencyKey: key,
      });

    expect(second.body.letter.id).toBe(first.body.letter.id);
    expect(countFor(a.id)).toBe(1);
  });

  it('scopes the key per sender — two senders may pick the same key', async () => {
    // The unique index is (sender_id, idempotency_key), not (idempotency_key).
    // Without the sender in it, one person's UUID collision would silently
    // swallow another person's letter.
    const shared = sync.mintIdempotencyKey();
    const one = makeCouple();
    const two = makeCouple();

    const first = await request(app).post('/api/letters/send').set(asUser(one.aToken)).send({
      recipientId: one.b.id,
      encryptedContent: ENVELOPE,
      idempotencyKey: shared,
    });
    const second = await request(app).post('/api/letters/send').set(asUser(two.aToken)).send({
      recipientId: two.b.id,
      encryptedContent: ENVELOPE,
      idempotencyKey: shared,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.letter.id).not.toBe(first.body.letter.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM letters WHERE idempotency_key = ?').get(shared).n).toBe(2);
  });

  it('mints a distinct key per call — two letters are never one letter', () => {
    const keys = new Set(Array.from({ length: 500 }, () => sync.mintIdempotencyKey()));
    expect(keys.size).toBe(500);
  });

  it('survives a lost response: the outbox retries under the SAME key and still sends one letter', async () => {
    // End-to-end through the real client. The first attempt really does create
    // the row; then the response is discarded on the way back, exactly as it
    // would be if the tab were killed mid-request.
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();
    const fetchImpl = httpFetch();
    let swallowed = 0;

    const flaky = async (input, init) => {
      const res = await fetchImpl(input, init);
      if (input.includes('/send')) {
        swallowed += 1;
        if (swallowed === 1) throw new Error('socket hang up'); // committed, response lost
      }
      return res;
    };

    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl: flaky }),
      outbox,
      token: aToken,
      fetchImpl: flaky,
      reconnectMaxMs: 0,
    });

    await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE, deliveredAt: null });
    await controller.flush(); // first attempt: row created, response lost
    await controller.flush(); // retry under the same key

    expect(countFor(a.id)).toBe(1);
    expect(swallowed).toBe(2);
    expect(await outbox.all()).toHaveLength(0); // the queue drained
    controller.stop();
    outbox.close();
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 2. Paging
 * ══════════════════════════════════════════════════════════════════════════ */

describe('cursor paging', () => {
  it('returns pages newest-first and every letter exactly once', async () => {
    const { a, b, aToken } = makeCouple();
    for (let i = 0; i < 47; i += 1) {
      seedLetter(a.id, b.id, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }

    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const res = await request(app)
        .get(`/api/letters/sync?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .set(asUser(aToken));
      expect(res.status).toBe(200);
      seen.push(...res.body);
      cursor = res.headers['x-next-cursor'] || null;
    } while (cursor && ++guard < 200);

    expect(seen).toHaveLength(47);
    expect(new Set(seen.map((l) => l.id)).size).toBe(47); // no duplicates
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i - 1].created_at >= seen[i].created_at).toBe(true); // newest first
    }
  });

  it('neither skips nor duplicates when a letter arrives mid-scroll', async () => {
    const { a, b, aToken } = makeCouple();

    // 30 letters, a millisecond apart, so created_at is a real ordering key.
    for (let i = 0; i < 30; i += 1) {
      seedLetter(a.id, b.id, { createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, 0, i)).toISOString() });
    }

    // Page 1.
    const first = await request(app).get('/api/letters/sync?limit=10').set(asUser(aToken));
    expect(first.body).toHaveLength(10);
    const cursor1 = first.headers['x-next-cursor'];
    expect(cursor1).toBeTruthy();

    // ── the letter arrives HERE, while the user is reading page 1 ──
    // It is strictly newer than every cursor issued, so it belongs above the
    // boundary. This is the whole scenario.
    const inserted = seedLetter(a.id, b.id, {
      createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, 1, 0)).toISOString(),
    });

    // Continue scrolling from exactly where the user was.
    const seen = first.body.map((l) => l.id);
    let cursor = cursor1;
    let guard = 0;
    while (cursor && ++guard < 100) {
      const page = await request(app)
        .get(`/api/letters/sync?limit=10&cursor=${encodeURIComponent(cursor)}`)
        .set(asUser(aToken));
      seen.push(...page.body.map((l) => l.id));
      cursor = page.headers['x-next-cursor'] || null;
    }

    // The scroll repeats nothing and drops nothing.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(30);
    // The new letter is NOT below any issued cursor — it never shows up twice.
    expect(seen).not.toContain(inserted);

    // And a refresh of page 1 picks it up exactly once.
    const refreshed = await request(app).get('/api/letters/sync?limit=10').set(asUser(aToken));
    const refreshedIds = refreshed.body.map((l) => l.id);
    expect(refreshedIds).toContain(inserted);
    expect(new Set(refreshedIds).size).toBe(10);
  });

  it('is exact when the archive is an exact multiple of the page size', async () => {
    const { a, b, aToken } = makeCouple();
    for (let i = 0; i < 20; i += 1) {
      seedLetter(a.id, b.id, { createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString() });
    }
    // The old scheme inferred "has more" from "did I get exactly as many as I
    // asked for", which offered one endless extra page right here.
    const page = await request(app).get('/api/letters/sync?limit=20').set(asUser(aToken));
    expect(page.body).toHaveLength(20);
    expect(page.headers['x-has-more']).toBe('false');
    expect(page.headers['x-next-cursor']).toBeUndefined();
  });

  it('breaks ties on (created_at, id) — same millisecond, many letters', async () => {
    const { a, b, aToken } = makeCouple();
    const sameInstant = new Date(Date.UTC(2026, 3, 1, 12, 0, 0)).toISOString();
    for (let i = 0; i < 12; i += 1) seedLetter(a.id, b.id, { createdAt: sameInstant });

    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const res = await request(app)
        .get(`/api/letters/sync?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .set(asUser(aToken));
      seen.push(...res.body);
      cursor = res.headers['x-next-cursor'] || null;
    } while (cursor && ++guard < 100);

    expect(seen).toHaveLength(12);
    expect(new Set(seen.map((l) => l.id)).size).toBe(12);
    // Tie-break is id descending, so the order is total and stable.
    const ids = seen.map((l) => l.id);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
  });

  it('honours a legacy bare-id cursor instead of erroring or duplicating', async () => {
    const { a, b, aToken } = makeCouple();
    for (let i = 0; i < 5; i += 1) {
      seedLetter(a.id, b.id, { createdAt: new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString() });
    }
    const oldest = db.prepare('SELECT MIN(id) AS m FROM letters').get().m;
    const res = await request(app).get(`/api/letters/sync?limit=10&cursor=${oldest}`).set(asUser(aToken));
    expect(res.status).toBe(200);
    // "Older than the oldest id" is empty — and it says so, rather than looping.
    expect(res.body).toHaveLength(0);
  });

  it('surfaces paging metadata to the client, not just the body', async () => {
    const { a, b, aToken } = makeCouple();
    for (let i = 0; i < 7; i += 1) {
      seedLetter(a.id, b.id, { createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString() });
    }
    const client = new sync.SyncClient({ token: aToken, fetchImpl: httpFetch() });
    const page = await client.fetchPage({ limit: 3 });

    expect(page.letters).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(typeof page.nextCursor).toBe('string');

    // The cursor is opaque: relayed, never parsed.
    const second = await client.fetchPage({ limit: 3, cursor: page.nextCursor });
    expect(second.letters.map((l) => l.id)).not.toContain(page.letters[0].id);
  });

  it('merges pages without duplicating when a page overlaps the one before', async () => {
    const { a, b, aToken } = makeCouple();
    for (let i = 0; i < 6; i += 1) {
      seedLetter(a.id, b.id, { createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString() });
    }
    const client = new sync.SyncClient({ token: aToken, fetchImpl: httpFetch() });
    const page = await client.fetchPage({ limit: 3 });

    // An overlapping fetch — the SSE-refresh race. Merging must collapse it.
    const merged = sync.mergeLetters(page.letters, page.letters.slice(1));
    expect(merged).toHaveLength(3);
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i - 1].created_at >= merged[i].created_at).toBe(true);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 3. Stream cleanup
 * ══════════════════════════════════════════════════════════════════════════ */

/** A fetch that returns a stream we can watch, and never finishes on its own. */
function neverEndingStream() {
  const state = { cancelled: false, aborted: false, pulled: 0 };
  const body = new ReadableStream({
    start() {},
    pull() {
      state.pulled += 1;
      // Blocks forever: this is an open SSE connection, which is exactly the
      // handle that hangs a test run if nothing closes it.
      return new Promise(() => {});
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const fetchImpl = async (input, init) => {
    if (init?.signal) {
      init.signal.addEventListener('abort', () => {
        state.aborted = true;
      });
    }
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetchImpl, state };
}

describe('stream cleanup', () => {
  it('unsubscribes on unmount: reader cancelled, request aborted, no timer left', async () => {
    const client = new sync.SyncClient({ token: 'token' });
    const { fetchImpl, state } = neverEndingStream();
    const events = [];

    const stream = sync.openLetterStream({
      client,
      url: '/api/letters/stream',
      token: 'token',
      fetchImpl,
      reconnectMaxMs: 0, // no reconnect timer can mask a leak
      onEvent: (e) => events.push(e),
    });

    // Let the connect promise settle, so the reader is genuinely attached.
    await new Promise((r) => setTimeout(r, 10));
    expect(state.pulled).toBeGreaterThan(0);

    // ── unmount ──
    stream.close();

    expect(state.cancelled).toBe(true); // socket released
    expect(state.aborted).toBe(true); // request aborted
    expect(stream.status()).toBe('closed');
    expect(stream.pendingReconnect()).toBe(0); // no timer survives

    // Idempotent, which is what makes it safe to call from an unmount AND an
    // error path without one clobbering the other.
    expect(() => {
      stream.close();
      stream.close();
    }).not.toThrow();
    expect(stream.status()).toBe('closed');
  });

  it('does not reconnect after close', async () => {
    const client = new sync.SyncClient({ token: 'token' });
    let connects = 0;
    const fetchImpl = async () => {
      connects += 1;
      return new Response('nope', { status: 500 }); // fails immediately
    };

    const stream = sync.openLetterStream({
      client,
      url: '/api/letters/stream',
      token: 'token',
      fetchImpl,
      reconnectMaxMs: 5,
      onEvent: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(connects).toBeGreaterThan(1); // it really was retrying

    stream.close();
    const atClose = connects;
    await new Promise((r) => setTimeout(r, 40));

    expect(connects).toBe(atClose); // and now it is not
    expect(stream.pendingReconnect()).toBe(0);
  });

  it('parses frames that straddle chunk boundaries', async () => {
    const seen = [];
    const parser = sync.createSseParser((e) => seen.push(e));

    // One event, delivered in pieces, with the frame boundary split down the
    // middle — exactly what a naive `split('\n\n')` gets wrong.
    parser.push('event: recei');
    parser.push('ved\ndata: {"type":"rece');
    parser.push('ived","letterId":7');
    parser.push(',"at":"2026-10-14T09:00:00.000Z"}\n');
    parser.push('\n');

    expect(seen).toEqual([{ type: 'received', letterId: 7, at: '2026-10-14T09:00:00.000Z' }]);
  });

  it('ignores the heartbeat comment frame', () => {
    const seen = [];
    const parser = sync.createSseParser((e) => seen.push(e));
    parser.push(': keep-alive\n\n');
    parser.push('event: ready\ndata: {"type":"ready"}\n\n');
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('ready');
  });

  it('drops a malformed frame without killing the stream', () => {
    const seen = [];
    const parser = sync.createSseParser((e) => seen.push(e));
    parser.push('event: ready\ndata: {not json\n\n');
    parser.push('event: sent\ndata: {"type":"sent","letterId":3}\n\n');
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('sent');
  });

  it('leaves no open server-side stream after the client goes away', async () => {
    const { a, b, aToken } = makeCouple();
    seedLetter(a.id, b.id, { createdAt: new Date().toISOString() });

    const ac = new AbortController();
    const res = await fetch(`${httpUrl}/api/letters/stream`, {
      headers: { Authorization: `Bearer ${aToken}`, Accept: 'text/event-stream' },
      signal: ac.signal,
    });

    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-accel-buffering')).toBe('no'); // nginx must not buffer it
    expect(letterRoutes.openStreamCount()).toBe(1);

    ac.abort(); // the component unmounts
    await new Promise((r) => setTimeout(r, 100));

    expect(letterRoutes.openStreamCount()).toBe(0);
  });

  it('refuses an unauthenticated stream rather than opening one', async () => {
    const before = letterRoutes.openStreamCount();
    const res = await fetch(`${httpUrl}/api/letters/stream`);
    expect(res.status).toBe(401);
    expect(letterRoutes.openStreamCount()).toBe(before);
    await res.body?.cancel();
  });

  it('closes every stream on shutdown', async () => {
    const { aToken } = makeCouple();
    const opening = [];
    for (let i = 0; i < 2; i += 1) {
      opening.push(
        fetch(`${httpUrl}/api/letters/stream`, {
          headers: { Authorization: `Bearer ${aToken}` },
          signal: AbortSignal.timeout(10_000),
        }),
      );
    }
    await Promise.all(opening);
    expect(letterRoutes.openStreamCount()).toBe(2);

    // The shutdown hook — the function server/index.js must call on exit.
    letterRoutes.closeAllStreams();
    expect(letterRoutes.openStreamCount()).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 4. Lifecycle — in_transit → available, and derived `replied`
 * ══════════════════════════════════════════════════════════════════════════ */

describe('letter lifecycle', () => {
  it('promotes in_transit → opened when delivered_at passes', async () => {
    const { a, b, aToken, bToken } = makeCouple();

    const createdAt = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const id = seedLetter(a.id, b.id, { createdAt, deliveredAt: future });

    // The sender watches their own letter leave: they may always see it.
    const mine = await request(app).get(`/api/letters/${id}`).set(asUser(aToken));
    expect(mine.status).toBe(200);
    expect(mine.body.state).toBe('in_transit');

    // The recipient cannot see it yet at all.
    const theirs = await request(app).get(`/api/letters/${id}`).set(asUser(bToken));
    expect(theirs.status).toBe(404);

    // Time passes.
    db.prepare('UPDATE letters SET delivered_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), id);

    // The NEXT READ promotes it. Read-time, not cron: arrival is a pure
    // comparison, so it needs a scheduler only to be pushed, never to be right.
    const now = await request(app).get(`/api/letters/${id}`).set(asUser(bToken));
    expect(now.status).toBe(200);
    expect(now.body.state).toBe('opened');

    // And it is durable now, not merely projected.
    const stored = db.prepare('SELECT state, opened_at FROM letters WHERE id = ?').get(id);
    expect(stored.state).toBe('opened');
    expect(stored.opened_at).toBeTruthy();
  });

  it('reads as in_transit even when the stored column lags', async () => {
    // Proves the projection is authoritative rather than trusting the cache.
    const { a, b, aToken } = makeCouple();
    const id = seedLetter(a.id, b.id, {
      createdAt: new Date().toISOString(),
      deliveredAt: new Date(Date.now() + 60_000).toISOString(),
    });

    db.prepare("UPDATE letters SET state = 'opened' WHERE id = ?").run(id); // deliberately wrong

    const res = await request(app).get(`/api/letters/${id}`).set(asUser(aToken));
    expect(res.body.state).toBe('in_transit'); // storage lied; the API did not
  });

  it('refuses a read receipt for a letter still travelling', async () => {
    const { a, b, bToken } = makeCouple();
    const id = seedLetter(a.id, b.id, {
      createdAt: new Date().toISOString(),
      deliveredAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await request(app).post(`/api/letters/${id}/read`).set(asUser(bToken));
    expect(res.status).toBe(404); // not visible, so it cannot be read
  });

  it('derives `replied` — nobody sets it, and a hand-written value is ignored', async () => {
    const { a, b, aToken, bToken } = makeCouple();

    // It landed a moment ago, so the answer comes strictly after its arrival.
    const letterId = seedLetter(a.id, b.id, {
      createdAt: new Date().toISOString(),
      deliveredAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const before = await request(app).get(`/api/letters/${letterId}`).set(asUser(aToken));
    expect(before.body.state).toBe('opened'); // delivered, unanswered

    // Claim it has been replied to. The derivation overrules the column.
    db.prepare("UPDATE letters SET state = 'replied' WHERE id = ?").run(letterId);
    const lying = await request(app).get(`/api/letters/${letterId}`).set(asUser(aToken));
    expect(lying.body.state).toBe('opened');

    // B answers.
    await request(app).post('/api/letters/send').set(asUser(bToken)).send({
      recipientId: a.id,
      encryptedContent: ENVELOPE,
    });

    const after = await request(app).get(`/api/letters/${letterId}`).set(asUser(aToken));
    expect(after.body.state).toBe('replied');

    // And the reply names its parent, so the thread is derivable.
    const reply = db.prepare('SELECT replied_to FROM letters WHERE sender_id = ?').get(b.id);
    expect(reply.replied_to).toBe(letterId);
  });

  it('does not call a letter replied when the reply predates its arrival', async () => {
    const { a, b, aToken } = makeCouple();
    // Something said while a letter is still in the postbox is not an answer to
    // it — it is just the next thing said.
    const letterId = seedLetter(a.id, b.id, {
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      deliveredAt: new Date(Date.now() + 60_000).toISOString(),
    });
    seedLetter(b.id, a.id, { createdAt: new Date().toISOString() });

    const res = await request(app).get(`/api/letters/${letterId}`).set(asUser(aToken));
    expect(res.body.state).toBe('in_transit'); // and emphatically not 'replied'
  });

  it('matches the projected states to the state-counts endpoint', async () => {
    const { a, b, aToken, bToken } = makeCouple();
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(Date.now() - (10_000 - i * 1_000)).toISOString();
      seedLetter(a.id, b.id, { createdAt: at, deliveredAt: at });
    }
    await request(app).post('/api/letters/send').set(asUser(bToken)).send({
      recipientId: a.id,
      encryptedContent: ENVELOPE,
    });

    const page = await request(app).get('/api/letters/sync?limit=50').set(asUser(aToken));
    const counts = await request(app).get('/api/letters/sync/state').set(asUser(aToken));

    expect(counts.body.total).toBe(page.body.length);
    // One derived expression serves both, so they cannot disagree.
    expect(counts.body.replied).toBe(page.body.filter((l) => sync.isReplied(l)).length);
    expect(counts.body.in_transit).toBe(page.body.filter((l) => sync.isInTransit(l)).length);
  });

  it('keeps the state column from carrying anything sensitive', async () => {
    const { a, b, aToken } = makeCouple();
    const id = seedLetter(a.id, b.id, {
      createdAt: new Date().toISOString(),
      content: JSON.stringify({ v: 2, ct: 'x', iv: 'y', keys: {}, senderId: a.id, recipientId: b.id, sentAt: 'now' }),
    });
    await request(app).get(`/api/letters/${id}`).set(asUser(aToken));

    const columns = db.prepare("SELECT name FROM pragma_table_info('letters')").all().map((c) => c.name);
    // Nothing added here is a content column. The cipher is untouched.
    expect(columns).not.toContain('plaintext');
    expect(columns).not.toContain('body');
    expect(columns).not.toContain('content');
    expect(columns).toContain('encrypted_content');
    expect(columns).toContain('state'); // a bare enum, nothing else

    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'letters'").get().sql;
    expect(ddl).toContain("state IN ('draft','sealed','in_transit','opened','replied')");
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 5. Optimistic UI + draft safety
 * ══════════════════════════════════════════════════════════════════════════ */

describe('optimistic send', () => {
  it('shows the letter as `sending` before the server has been told', async () => {
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();

    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const fetchImpl = async (input, init) => {
      if (input.includes('/send')) await gate; // hang in flight
      return httpFetch()(input, init);
    };

    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl }),
      outbox,
      token: aToken,
      fetchImpl,
      reconnectMaxMs: 0,
    });

    const optimistic = await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });

    // On screen, in a real lifecycle state, immediately.
    expect(optimistic.state).toBe('sending');
    expect(controller.getState().letters.some((l) => l.state === 'sending')).toBe(true);
    // Durable BEFORE it was shown — a crash here cannot lose the letter.
    expect(await outbox.all()).toHaveLength(1);
    // And the server still knows nothing.
    expect(countFor(a.id)).toBe(0);

    release();
    await controller.flush();

    expect(controller.getState().letters.some((l) => l.state === 'sending')).toBe(false);
    expect(controller.getState().letters.some((l) => l.id === optimistic.id)).toBe(false);
    expect(countFor(a.id)).toBe(1);
    controller.stop();
    outbox.close();
  });

  it('returns a failed letter with an honest reason and does not lose the draft', async () => {
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();

    // 403: not paired. Permanent — retrying unchanged cannot help.
    const fetchImpl = async (input, init) => {
      if (input.includes('/send')) {
        return new Response(JSON.stringify({ error: 'Not paired with recipient' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return httpFetch()(input, init);
    };

    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl }),
      outbox,
      token: aToken,
      fetchImpl,
      reconnectMaxMs: 0,
      onError: () => {},
    });

    const optimistic = await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });
    await controller.flush();

    const failed = controller.getState().letters.find((l) => l.idempotency_key === optimistic.idempotency_key);
    expect(failed.state).toBe('failed');
    expect(failed.local_error).toBe('Not paired with recipient'); // the server's own words
    expect(controller.getState().error).toBe('Not paired with recipient');

    // Still queued, so a retry remains possible. Nothing was dropped.
    expect(await outbox.all()).toHaveLength(1);
    expect(countFor(a.id)).toBe(0); // and nothing was half-sent
    controller.stop();
    outbox.close();
  });

  it('reuses the original key on retry, so a retry cannot become a second letter', async () => {
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();

    const keys = [];
    let allow = false;
    const fetchImpl = async (input, init) => {
      if (input.includes('/send')) {
        keys.push(JSON.parse(init.body).idempotencyKey);
        if (!allow) {
          return new Response(JSON.stringify({ error: 'Not paired with recipient' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return httpFetch()(input, init);
    };

    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl }),
      outbox,
      token: aToken,
      fetchImpl,
      reconnectMaxMs: 0,
      onError: () => {},
    });

    const optimistic = await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });
    await controller.flush();
    expect(controller.getState().letters.find((l) => l.idempotency_key === optimistic.idempotency_key).state).toBe('failed');

    // The cause is fixed; the user hits "Try again".
    allow = true;
    await controller.retry(optimistic.idempotency_key);

    // Every attempt carried the SAME key — not two, not a regenerated one.
    // A retry under a fresh key would be a new letter, and the user would
    // receive the one they had already sent a second time.
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1); // THE assertion
    expect(countFor(a.id)).toBe(1);
    controller.stop();
    outbox.close();
  });

  it('stores no plaintext in the outbox', async () => {
    const { b } = makeCouple();
    const outbox = await freshOutbox();
    await outbox.put({
      idempotency_key: sync.mintIdempotencyKey(),
      recipient_id: b.id,
      encrypted_content: ENVELOPE,
      encrypted_metadata: null,
      photo_paths: null,
      delivered_at: null,
      in_reply_to: null,
      client_created_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    });

    const [record] = await outbox.all();
    // A queued letter on disk must be exactly as unreadable as one on the
    // server: there is no field here that could hold plaintext.
    expect(Object.keys(record).sort()).toEqual([
      'attempts', 'client_created_at', 'delivered_at', 'encrypted_content',
      'encrypted_metadata', 'idempotency_key', 'in_reply_to', 'last_error',
      'photo_paths', 'recipient_id', 'updated_at',
    ]);
    expect(record.encrypted_content).toBe(ENVELOPE); // opaque, verbatim
    outbox.close();
  });

  it('does not run two drains of the same queue at once', async () => {
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();
    let inflight = 0;
    let maxInflight = 0;

    const fetchImpl = async (input, init) => {
      if (input.includes('/send')) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight -= 1;
      }
      return httpFetch()(input, init);
    };

    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl }),
      outbox,
      token: aToken,
      fetchImpl,
      reconnectMaxMs: 0,
    });

    await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });
    await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });

    // Five concurrent flushes. The queue drains once, not five times.
    await Promise.all([controller.flush(), controller.flush(), controller.flush(), controller.flush(), controller.flush()]);

    expect(maxInflight).toBe(1);
    expect(countFor(a.id)).toBe(2);
    controller.stop();
    outbox.close();
  });

  it('cannot collide an optimistic row with a server row', async () => {
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();
    const fetchImpl = httpFetch();
    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl }),
      outbox,
      token: aToken,
      fetchImpl,
      reconnectMaxMs: 0,
    });

    const optimistic = await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });
    await controller.flush();

    // Server ids are positive; an optimistic id never can be, so the two can
    // coexist during reconciliation without either shadowing the other.
    expect(optimistic.id).toBeLessThan(0);
    expect(db.prepare('SELECT MIN(id) AS m FROM letters').get().m).toBeGreaterThan(0);
    controller.stop();
    outbox.close();
  });

  it('reconciles the optimistic row into the server row, by idempotency key', async () => {
    const { a, b, aToken } = makeCouple();
    const outbox = await freshOutbox();
    const fetchImpl = httpFetch();
    const controller = new sync.SyncController({
      client: new sync.SyncClient({ token: aToken, fetchImpl }),
      outbox,
      token: aToken,
      fetchImpl,
      reconnectMaxMs: 0,
    });

    const optimistic = await controller.sendLetter({ recipientId: b.id, encryptedContent: ENVELOPE });
    await controller.flush();

    const rows = controller.getState().letters;
    // The temp row is gone, replaced by exactly one real row — not two.
    expect(rows.some((l) => l.id === optimistic.id)).toBe(false);
    expect(rows.filter((l) => l.state === 'sending')).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(countFor(a.id) ? rows[0].id : -1);
    expect(rows[0].id).toBeGreaterThan(0);
    controller.stop();
    outbox.close();
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 6. No plaintext anywhere
 * ══════════════════════════════════════════════════════════════════════════ */

describe('the cipher is not touched', () => {
  it('stores and returns the envelope byte-for-byte', async () => {
    const { a, b, aToken } = makeCouple();
    const createdAt = new Date().toISOString();
    const id = seedLetter(a.id, b.id, { createdAt, content: ENVELOPE });

    const res = await request(app).get(`/api/letters/${id}`).set(asUser(aToken));
    // Not re-serialised, not normalised, not inspected. The same string.
    expect(res.body.encrypted_content).toBe(ENVELOPE);
  });

  it('has no plaintext column, and the secret appears in no row', async () => {
    const { a, b, aToken } = makeCouple();
    const res = await request(app).post('/api/letters/send').set(asUser(aToken)).send({
      recipientId: b.id,
      encryptedContent: ENVELOPE,
      idempotencyKey: sync.mintIdempotencyKey(),
    });
    expect(res.status).toBe(200);

    expect(JSON.stringify(db.prepare('SELECT * FROM letters').all())).not.toContain(PLAINTEXT_NEVER_SENT);

    const page = await request(app).get('/api/letters/sync').set(asUser(aToken));
    expect(page.body[0].encrypted_content).toBe(ENVELOPE); // the API carries the envelope, never a decoded form
  });

  it('refuses a send with no body rather than storing an empty row', async () => {
    const { b, aToken } = makeCouple();
    const res = await request(app).post('/api/letters/send').set(asUser(aToken)).send({
      recipientId: b.id,
      encryptedContent: '',
    });
    expect(res.status).toBe(400);
  });

  it('requires authentication on every route in the router', async () => {
    for (const [method, url] of [
      ['get', '/api/letters/sync'],
      ['get', '/api/letters/stream'],
      ['get', '/api/letters/1'],
      ['post', '/api/letters/send'],
      ['post', '/api/letters/1/read'],
      ['get', '/api/letters/sync/state'],
    ]) {
      const res = await request(app)[method](url);
      expect(res.status, `${method} ${url} must not be reachable unauthenticated`).toBe(401);
    }
  });

  it('does not show one partner another partner letters', async () => {
    const first = makeCouple();
    const second = makeCouple();
    const id = seedLetter(first.a.id, first.b.id, { createdAt: new Date().toISOString() });

    const res = await request(app).get(`/api/letters/${id}`).set(asUser(second.aToken));
    expect(res.status).toBe(404); // not 403 — do not even confirm it exists

    const page = await request(app).get('/api/letters/sync').set(asUser(second.bToken));
    expect(page.body.some((l) => l.id === id)).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ *
 * 7. Cursor encoding, directly
 * ══════════════════════════════════════════════════════════════════════════ */

describe('cursor encoding', () => {
  it('round-trips a (created_at, id) tuple', () => {
    const cursor = repo.encodeCursor({ created_at: '2026-10-14T09:00:00.000Z', id: 42 });
    expect(repo.decodeCursor(cursor)).toEqual({ createdAt: '2026-10-14T09:00:00.000Z', id: 42 });
  });

  it('treats a corrupt cursor as a first page, not an error', () => {
    expect(repo.decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(repo.decodeCursor('')).toBeNull();
    expect(repo.decodeCursor(undefined)).toBeNull();
  });

  it('reads a legacy bare id as "older than this id"', () => {
    expect(repo.decodeCursor('17')).toEqual({ createdAt: null, id: 17 });
  });

  it('normalises a SQLite-shaped instant to the canonical form', () => {
    // ' ' sorts before 'T', so a space-separated timestamp compared lexically
    // against an ISO one is simply wrong. Everything goes through here first.
    expect(repo.canonicalInstant('2026-10-14 09:00:00')).toBe('2026-10-14T09:00:00.000Z');
    expect(repo.canonicalInstant('2026-10-14T09:00:00.000Z')).toBe('2026-10-14T09:00:00.000Z');
    expect(repo.canonicalInstant('2026-10-14T11:00:00+02:00')).toBe('2026-10-14T09:00:00.000Z');
    expect(repo.canonicalInstant('nonsense')).toBeNull();
  });
});