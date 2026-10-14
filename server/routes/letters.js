'use strict';

/**
 * /api/letters — lifecycle, paging, live updates, and the offline outbox's
 * server half (plan steps 9 and 10).
 *
 * Mount it with:
 *
 *     app.use('/api/letters', letterRoutes());
 *
 * BEFORE any inline `app.post('/api/letters/send')` / `app.get('/api/letters/sync')`
 * in server/index.js — Express takes the first match, so a `use()` registered
 * after them is dead code.
 *
 * Response shapes are chosen to not break the existing client or the existing
 * tests: `/sync` still returns a BARE ARRAY, because tests/api.test.js asserts
 * `res.body` is an array. The cursor travels in `X-Next-Cursor` / `X-Has-More`
 * instead.
 *
 * Nothing in this file decrypts anything. `encrypted_content` is written exactly
 * as `client/src/lib/crypto.ts` produced it and read back as an opaque string.
 */

const express = require('express');
const { authenticateToken, checkStr } = require('../lib/auth');
const repo = require('../repos/letters');

const DEFAULT_SWEEP_MS = 1_000;
const HEARTBEAT_MS = 25_000;

/**
 * One "bus" per router instance: its subscribers, its sweep timer, its arrival
 * fingerprints. Created by the factory, so a test that builds a router around an
 * in-memory handle gets its own bus and cannot touch the app singleton's.
 *
 * Every bus registers itself in `buses` so `closeAllStreams()` can reach them
 * all — that is the function to call from a shutdown hook, and the one the tests
 * use to prove nothing is left running.
 */
const buses = new Set();

function createBus(resolveDb) {
  /** userId -> Set<subscriber> */
  const subscribers = new Map();
  /** userId -> Set<letterId> of letters known to have landed */
  const landed = new Map();

  let sweeper = null;

  const bus = {
    subscribers,
    get openStreams() {
      let n = 0;
      for (const set of subscribers.values()) n += set.size;
      return n;
    },
    resolveDb,
    add,
    remove,
    publish,
    markLanded,
    publishArrivals,
    closeAll,
  };

  function publish(userId, event) {
    const set = subscribers.get(userId);
    if (!set || set.size === 0) return 0;
    let sent = 0;
    for (const sub of set) {
      if (sub.send(event)) sent += 1;
    }
    return sent;
  }

  /**
   * Announce letters that landed since the last look.
   *
   * Signals only — `{type:'arrived', letterId}` is the whole message. Enough for
   * the client to re-page; not enough for this to become a channel over which
   * anything could leak.
   */
  function publishArrivals(userId, at) {
    const set = subscribers.get(userId);
    if (!set || set.size === 0) return;

    let handle;
    try {
      handle = resolveDb();
      repo.reconcileStates(handle, userId, at);
    } catch {
      return; // One unreadable database must not silence every other stream.
    }

    let rows;
    try {
      rows = handle
        .prepare(
          `SELECT l.id,
                  CASE WHEN l.delivered_at IS NULL OR l.delivered_at <= :now THEN 1 ELSE 0 END AS arrived
             FROM letters l
            WHERE (l.sender_id = :uid OR l.recipient_id = :uid)
            ORDER BY l.created_at DESC, l.id DESC
            LIMIT 200`,
        )
        .all({ uid: userId, now: at });
    } catch {
      return;
    }

    const known = landed.get(userId);
    const next = new Set();
    for (const row of rows) {
      if (!row.arrived) continue;
      next.add(row.id);
      // The very first sweep establishes the baseline and announces nothing.
      // Without this, reconnecting would replay every letter ever received.
      if (known && !known.has(row.id)) {
        publish(userId, { type: 'arrived', letterId: row.id, at });
      }
    }
    landed.set(userId, next);
  }

  /**
   * Records a letter as already-announced for a user.
   *
   * Without this, `/send` pushing `received` would be followed 200ms later by the
   * sweep announcing the same letter as `arrived`, and the client would re-page
   * twice for one letter. Arrival bookkeeping and the send push share one record.
   */
  function markLanded(userId, letterId) {
    if (!subscribers.has(userId)) return;
    let set = landed.get(userId);
    if (!set) {
      set = new Set();
      landed.set(userId, set);
    }
    set.add(letterId);
  }

  function sweep() {
    const at = repo.nowInstant();
    for (const userId of Array.from(subscribers.keys())) {
      publishArrivals(userId, at);
    }
  }

  function startSweeper() {
    if (sweeper) return;
    const configured = Number.parseInt(process.env.LETTERS_SWEEP_MS, 10);
    const every = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SWEEP_MS;
    sweeper = setInterval(sweep, every);
    // A pending interval keeps a Node process alive. A process that will not exit
    // is a CI job that hangs until it is killed, so EVERY timer this module
    // creates is unref'd. The sweep is stopped outright when the last stream
    // leaves; this is the belt to that braces.
    if (typeof sweeper.unref === 'function') sweeper.unref();
  }

  function stopSweeper() {
    if (!sweeper) return;
    clearInterval(sweeper);
    sweeper = null;
  }

  function add(userId, sub) {
    let set = subscribers.get(userId);
    if (!set) {
      set = new Set();
      subscribers.set(userId, set);
    }
    set.add(sub);
    startSweeper();
  }

  function remove(userId, sub) {
    const set = subscribers.get(userId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) {
      subscribers.delete(userId);
      landed.delete(userId);
      // Nothing left to push to. Stop the timer rather than leaving a no-op
      // interval resident in the process for the rest of its life.
      stopSweeper();
    }
  }

  function closeAll() {
    for (const userId of Array.from(subscribers.keys())) {
      for (const sub of Array.from(subscribers.get(userId) || [])) {
        sub.close();
      }
    }
    subscribers.clear();
    landed.clear();
    stopSweeper();
    buses.delete(bus);
  }

  return bus;
}

/** Closes every stream on every router instance. The shutdown hook. */
function closeAllStreams() {
  for (const bus of Array.from(buses)) bus.closeAll();
}

const openStreamCount = () => {
  let n = 0;
  for (const bus of buses) n += bus.openStreams;
  return n;
};

/**
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db] handle to use instead
 *   of the app singleton. Tests pass one; production passes nothing.
 */
module.exports = function letterRoutes(options = {}) {
  const injected = options.db || null;

  // Resolved per call rather than captured at module load, so a caller can hand
  // in a handle after the router was constructed.
  const resolveDb = () => injected || require('../db').getDb();

  const bus = createBus(resolveDb);
  buses.add(bus);

  const r = express.Router();

  // ------------------------------------------------------------------ auth --
  /**
   * `EventSource` cannot set an Authorization header, so the stream accepts the
   * bearer token as a query parameter. That puts a JWT in a URL, where it can end
   * up in a proxy access log — so it is a compatibility path only, and the
   * shipped client (client/src/lib/sync.ts) uses fetch() with a header instead.
   *
   * Everything past this line is authenticated. There is no unguarded route in
   * this router.
   */
  r.use((req, _res, next) => {
    if (!req.headers.authorization) {
      const queryToken = req.query?.access_token || req.query?.token;
      if (queryToken) req.headers.authorization = `Bearer ${queryToken}`;
    }
    next();
  });
  r.use(authenticateToken);

  // ---------------------------------------------------------------- stream --
  /**
   * GET /stream — text/event-stream.
   *
   * Auth already ran above, so this handler only has to make the stream.
   */
  r.get('/stream', (req, res) => openStream(req, res));

  function openStream(req, res) {
    const userId = req.user.id;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx buffers an event stream into uselessness unless told not to.
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (typeof res.socket?.setNoDelay === 'boolean') res.socket.setNoDelay(true);
    if (typeof res.socket?.setKeepAlive === 'function') res.socket.setKeepAlive(true);

    let closed = false;

    const heartbeat = setInterval(() => {
      // A comment frame, not an event: proxies need to see bytes or they decide
      // the connection is idle and drop it.
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* the close handler runs the teardown */
      }
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const sub = {
      send: (event) => {
        if (closed) return false;
        try {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          return true;
        } catch {
          return false;
        }
      },
      close: () => {
        // Idempotent. `close` can arrive from res, from req, from an aborted
        // request, and from closeAllStreams — and the teardown must run exactly
        // once, because running it twice used to be a double clearInterval that
        // hid the case where it never ran at all.
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        bus.remove(userId, sub);
        try {
          res.end();
        } catch {
          /* already gone */
        }
      },
    };

    // `close` on the response is the reliable one in Express 5. `req` close and
    // `aborted` are registered too, because behaviour differs across HTTP
    // versions and a teardown missed here is a leaked interval in CI.
    res.on('close', sub.close);
    res.on('error', sub.close);
    req.on('close', sub.close);
    req.on('aborted', sub.close);

    bus.add(userId, sub);

    sub.send({ type: 'ready', at: repo.nowInstant() });
    // Establish the arrival baseline so the first sweep does not announce every
    // letter that ever arrived as brand new.
    bus.publishArrivals(userId, repo.nowInstant());

    return undefined;
  }

  // ------------------------------------------------------------------ sync --
  /**
   * GET /sync — one page of the archive, newest first.
   *
   * Bare array in the body (tests/api.test.js and the existing store both read
   * `res.body` directly). Paging metadata rides in headers:
   *   X-Next-Cursor — pass back as ?cursor= for the page of OLDER letters
   *   X-Has-More   — 'true' | 'false'
   */
  r.get('/sync', (req, res) => {
    const handle = resolveDb();
    const now = repo.nowInstant();
    const userId = req.user.id;

    repo.reconcileStates(handle, userId, now);

    const page = repo.pageLetters(handle, {
      userId,
      limit: req.query.limit,
      cursor: req.query.cursor,
      now,
    });

    if (page.nextCursor) res.setHeader('X-Next-Cursor', page.nextCursor);
    res.setHeader('X-Has-More', page.hasMore ? 'true' : 'false');
    res.setHeader('Cache-Control', 'no-store');
    res.json(page.letters);
  });

  /** GET /sync/state — counts by lifecycle state, same derived expression. */
  r.get('/sync/state', (req, res) => {
    const handle = resolveDb();
    const now = repo.nowInstant();
    repo.reconcileStates(handle, req.user.id, now);
    res.json(repo.stateCounts(handle, { userId: req.user.id, now }));
  });

  // ------------------------------------------------------------------ send --
  /**
   * POST /send — the envelope is already sealed; this only records and routes.
   *
   * Idempotent on `idempotencyKey`. The offline outbox (client/src/lib/sync.ts)
   * mints the key once, when the letter is composed, and reuses it for every
   * retry of that same letter — so a request whose response was lost is answered
   * with the original row instead of a second copy of a letter. A replay is
   * reported through `Idempotent-Replay: true`, because "I already had this" and
   * "I just made this" return the same body and a client cannot otherwise tell
   * them apart.
   */
  r.post('/send', (req, res) => {
    const {
      recipientId,
      encryptedContent,
      encryptedMetadata,
      photoPaths,
      deliveredAt,
      inReplyTo,
      idempotencyKey,
    } = req.body || {};

    if (!Number.isInteger(recipientId)) {
      return res.status(400).json({ error: 'recipientId must be an integer' });
    }
    const bad = checkStr(encryptedContent, { required: true, min: 1, max: 1_000_000 });
    if (bad) return res.status(400).json({ error: `Invalid letter body: ${bad}` });

    const keyBad =
      idempotencyKey === undefined || idempotencyKey === null
        ? null
        : checkStr(String(idempotencyKey), { min: 8, max: 128 });
    if (keyBad) return res.status(400).json({ error: `Invalid idempotencyKey: ${keyBad}` });

    try {
      const handle = resolveDb();
      if (!repo.isPaired(handle, req.user.id, recipientId)) {
        return res.status(403).json({ error: 'Not paired with recipient' });
      }

      let parent = null;
      if (inReplyTo !== undefined && inReplyTo !== null) {
        if (!Number.isInteger(Number(inReplyTo))) {
          return res.status(400).json({ error: 'inReplyTo must be an integer' });
        }
        parent = Number(inReplyTo);
        if (!repo.isValidReplyTarget(handle, { repliedTo: parent, senderId: req.user.id, recipientId })) {
          return res.status(400).json({ error: 'inReplyTo is not a letter you received' });
        }
      }

      const { row, duplicate } = repo.createLetter(handle, {
        senderId: req.user.id,
        recipientId,
        encryptedContent,
        encryptedMetadata: encryptedMetadata ?? null,
        photoPaths: photoPaths ?? null,
        deliveredAt: deliveredAt ?? null,
        repliedTo: parent,
        idempotencyKey: idempotencyKey ?? null,
      });

      if (duplicate) res.setHeader('Idempotent-Replay', 'true');

      const now = repo.nowInstant();
      const view = repo.getLetter(handle, { letterId: row.id, userId: req.user.id, now }) ?? row;

      if (!duplicate) {
        // Only light up the other person's phone if the letter is deliverable
        // now. One scheduled for next week is not news today.
        if (view.state !== 'in_transit') {
          bus.publish(recipientId, { type: 'received', letterId: view.id, at: now });
          bus.markLanded(recipientId, view.id);
        }
        bus.publish(req.user.id, { type: 'sent', letterId: view.id, at: now });
      }

      return res.json({ success: true, duplicate, letter: view });
    } catch (err) {
      // Logged, not returned: a self-hosted deployment reads these from docker
      // logs, and "Could not send letter" on its own tells an operator nothing.
      console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'letters.send failed', error: err && err.message }));
      return res.status(500).json({ error: 'Could not send letter' });
    }
  });

  // --------------------------------------------------------------- drafts ---
  /** POST /draft — a sealed envelope that has not left the machine. */
  r.post('/draft', (req, res) => {
    const { encryptedContent, encryptedMetadata } = req.body || {};
    const bad = checkStr(encryptedContent, { required: true, min: 1, max: 1_000_000 });
    if (bad) return res.status(400).json({ error: `Invalid draft body: ${bad}` });

    try {
      const handle = resolveDb();
      const { row } = repo.createLetter(handle, {
        senderId: req.user.id,
        recipientId: req.user.id,
        encryptedContent,
        encryptedMetadata: encryptedMetadata ?? null,
        requestedState: 'draft',
        notify: false,
      });
      return res.json({
        success: true,
        letter: repo.getLetter(handle, { letterId: row.id, userId: req.user.id }),
      });
    } catch {
      return res.status(500).json({ error: 'Could not save draft' });
    }
  });

  r.put('/:id/draft', (req, res) => {
    const { encryptedContent, encryptedMetadata } = req.body || {};
    const bad = checkStr(encryptedContent, { required: true, min: 1, max: 1_000_000 });
    if (bad) return res.status(400).json({ error: `Invalid draft body: ${bad}` });
    try {
      const handle = resolveDb();
      const ok = repo.updateDraft(handle, {
        letterId: req.params.id,
        userId: req.user.id,
        encryptedContent,
        encryptedMetadata,
      });
      if (!ok) return res.status(404).json({ error: 'No such draft' });
      return res.json({
        success: true,
        letter: repo.getLetter(handle, { letterId: req.params.id, userId: req.user.id }),
      });
    } catch {
      return res.status(500).json({ error: 'Could not update draft' });
    }
  });

  r.delete('/:id/draft', (req, res) => {
    try {
      const handle = resolveDb();
      const ok = repo.deleteDraft(handle, { letterId: req.params.id, userId: req.user.id });
      if (!ok) return res.status(404).json({ error: 'No such draft' });
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'Could not discard draft' });
    }
  });

  // ---------------------------------------------------------------- single --
  /** GET /:id — one letter, visibility-gated exactly like the list. */
  r.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid letter id' });
    try {
      const handle = resolveDb();
      const now = repo.nowInstant();
      repo.reconcileStates(handle, req.user.id, now);
      const letter = repo.getLetter(handle, { letterId: id, userId: req.user.id, now });
      if (!letter) return res.status(404).json({ error: 'Letter not found' });
      return res.json(letter);
    } catch {
      return res.status(500).json({ error: 'Could not read letter' });
    }
  });

  /**
   * POST /:id/read — the recipient opened it.
   *
   * Separate from `GET /:id` on purpose: opening is a write, and a `GET` that
   * silently mutates state is what makes a cache lie and makes a prefetch count
   * as a read.
   */
  r.post('/:id/read', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid letter id' });
    try {
      const handle = resolveDb();
      const now = repo.nowInstant();
      const letter = repo.getLetter(handle, { letterId: id, userId: req.user.id, now });
      if (!letter) return res.status(404).json({ error: 'Letter not found' });
      if (letter.state === 'in_transit') {
        return res.status(409).json({ error: 'Letter has not arrived yet', availableAt: letter.available_at });
      }
      const row = repo.markRead(handle, { letterId: id, userId: req.user.id, now });
      if (!row) return res.status(403).json({ error: 'Only the recipient can open this letter' });
      return res.json({
        success: true,
        letter: repo.getLetter(handle, { letterId: id, userId: req.user.id, now }),
      });
    } catch {
      return res.status(500).json({ error: 'Could not record the read' });
    }
  });

  r.bus = bus;
  return r;
};

module.exports.createBus = createBus;
module.exports.openStreamCount = openStreamCount;
module.exports.closeAllStreams = closeAllStreams;