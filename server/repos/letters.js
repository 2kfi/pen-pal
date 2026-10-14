'use strict';

/**
 * All letter data access (plan steps 9 and 10).
 *
 * Two things live here that did not exist before:
 *
 * 1. **Derived state.** `replied` is not something a caller declares. A letter is
 *    replied when its recipient has sent something after it became available to
 *    them, and `in_transit → opened` happens when `delivered_at` passes. Both are
 *    pure functions of stored columns, so they are computed at WRITE time by
 *    `reconcileStates` (a single indexed UPDATE per transition) and, critically,
 *    are *also* projected live in every SELECT. Storage can therefore lag and the
 *    API is still correct — which is what lets the transition be read-time.
 *
 * 2. **A real cursor.** The old scheme was `WHERE id > ? ORDER BY id ASC`, a
 *    forward cursor over an ascending list. The archive is newest-first, so that
 *    pairing is incoherent: paging forward from the oldest id while rendering
 *    newest-first means either skipping every letter written mid-scroll or
 *    re-serving it. The replacement pages BACKWARDS over a
 *    `(created_at, id)` tuple, which is the direction the UI actually scrolls.
 *    Insert-only traffic can then never fall behind the cursor: a new row is
 *    strictly newer than any cursor already issued, so it is picked up by a
 *    refresh of the first page and can never be duplicated by a scroll.
 *
 * Nothing here decrypts, inspects, or re-derives `encrypted_content`. The
 * envelope produced by client/src/lib/crypto.ts is opaque to the server and stays
 * opaque: there is no plaintext field anywhere in this file.
 */

// 040, not 030: the letter-states migration was renumbered when 030 was taken by
// auth-sessions, and this path is a hard require on any database that predates it.
const MIGRATION = '../lib/migrations/040-letter-states';

const STATES = Object.freeze(['draft', 'sealed', 'in_transit', 'opened', 'replied']);

const LIFECYCLE_RANK = Object.freeze({ draft: 0, sealed: 1, in_transit: 2, opened: 3, replied: 4 });

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Canonical instant: `YYYY-MM-DDTHH:MM:SS.mmmZ`, always, fixed width.
 *
 * The legacy schema mixed SQLite's `YYYY-MM-DD HH:MM:SS` with the ISO strings the
 * client sends. Compared lexically, `'2026-10-13 09:00:00' <= '2026-10-13T09:00:01.000Z'`
 * is TRUE (space sorts before `T`), so a letter scheduled for later that morning
 * would have been delivered the instant it was written. Everything written or
 * compared by this module goes through here first, which is what keeps
 * `delivered_at <= :now` a real comparison rather than a coincidence.
 */
function canonicalInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;

  const raw = String(value).trim();
  if (!raw) return null;

  let candidate = raw.replace(' ', 'T');
  if (!OFFSET_SUFFIX.test(candidate)) candidate += 'Z';

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const nowInstant = () => new Date().toISOString();

/** Database handles we have already brought up to the 040 schema. */
const ensured = new WeakSet();

/**
 * Applies migration 040 to a handle that predates it, once per handle.
 *
 * The migration runner owns schema. This is not a second copy of it — it defers
 * to the same module and only runs when the `state` column is absent, so a
 * database the runner has already migrated is untouched. It exists so the letters
 * router is usable against a database whose runner has not been wired yet, and so
 * a test can stand up a bare handle.
 */
function ensureSchema(db) {
  if (!db || ensured.has(db)) return;
  const hasState = db.prepare("SELECT 1 FROM pragma_table_info('letters') WHERE name = 'state'").get();
  if (!hasState) require(MIGRATION).up(db);
  ensured.add(db);
}

// ---------------------------------------------------------------------------
// visibility
// ---------------------------------------------------------------------------

/**
 * The one rule for who can see what.
 *
 * A sender always sees their own letter, including one still travelling — it is
 * sitting in their outbox and they should be able to watch it go. A recipient sees
 * a letter only once `delivered_at` has passed. Drafts are the sender's alone,
 * which falls out of the same clause.
 */
const VISIBLE = `(
  l.sender_id = :uid
  OR (l.recipient_id = :uid AND (l.delivered_at IS NULL OR l.delivered_at <= :now))
)`;

/**
 * Is this letter replied? A recipient has answered it if they have sent anything
 * back to the original sender strictly after it became available to them.
 *
 * `COALESCE(delivered_at, created_at)` is the moment of receipt: a scheduled
 * letter was not received when it was written, so a reply that went out while it
 * was still in the postbox does not count as an answer to it.
 */
const REPLY_EXISTS = `EXISTS (
  SELECT 1 FROM letters r
   WHERE r.sender_id = l.recipient_id
     AND r.recipient_id = l.sender_id
     AND r.state <> 'draft'
     AND r.created_at > COALESCE(l.delivered_at, l.created_at)
)`;

/**
 * The authoritative state, computed from storage on every read.
 *
 * This is what makes read-time promotion safe: the column may be a stale cache,
 * but nothing the API returns is ever derived from a stale column.
 */
const DERIVED_STATE = `CASE
  WHEN l.state = 'draft' THEN 'draft'
  WHEN l.delivered_at IS NOT NULL AND l.delivered_at > :now THEN 'in_transit'
  WHEN l.state IN ('sealed', 'in_transit') AND l.delivered_at IS NOT NULL
    THEN CASE WHEN ${REPLY_EXISTS} THEN 'replied' ELSE 'opened' END
  WHEN l.state IN ('opened', 'replied') THEN CASE WHEN ${REPLY_EXISTS} THEN 'replied' ELSE 'opened' END
  ELSE 'sealed'
END`;

const COLUMNS = `
  l.id, l.sender_id, l.recipient_id,
  l.encrypted_content, l.encrypted_metadata, l.photo_paths,
  l.sent_at, l.delivered_at, l.opened_at, l.read_at, l.replied_to,
  l.created_at, l.sync_version,
  ${DERIVED_STATE} AS state,
  COALESCE(l.delivered_at, l.created_at) AS available_at
`;

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

/**
 * Opaque, URL-safe, and a genuine tuple rather than a bare id.
 *
 * `created_at` alone is not unique (a phone can seal two letters inside one
 * millisecond) and `id` alone is not stable under concurrent inserts on any
 * scheme that tries to order by wall-clock. Together they are a total order, and
 * that total order is what makes the page boundary unambiguous.
 */
function encodeCursor(row) {
  const payload = JSON.stringify({ t: row.created_at, i: row.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Returns `{ createdAt, id }`, `{ id }` for a legacy bare-id cursor, or null.
 *
 * A legacy client is still holding `cursor=<id>` from the old ascending scheme.
 * Honouring it as "everything older than this id" degrades that client to correct
 * scrolling instead of a 400 or, worse, a silently duplicated page.
 */
function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;

  if (typeof raw === 'number' || /^-?\d+$/.test(String(raw))) {
    const id = Number(raw);
    return Number.isInteger(id) ? { createdAt: null, id } : null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (parsed && typeof parsed.t === 'string' && Number.isInteger(parsed.i)) {
      return { createdAt: parsed.t, id: parsed.i };
    }
  } catch {
    /* A corrupt cursor is a first page, not an error. */
  }
  return null;
}

const clampLimit = (value) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE;
  return Math.min(Math.max(n, 1), MAX_PAGE);
};

// ---------------------------------------------------------------------------
// reconciliation — the state machine, driven by reads
// ---------------------------------------------------------------------------

/**
 * Bring stored state up to date for one user's view.
 *
 * WHY READ-TIME AND NOT A CRON. A scheduled letter's arrival is a pure function
 * of `(delivered_at, now)` — there is nothing to compute once and store, only a
 * comparison. So the state does not need a scheduler to be *correct*; it needs one
 * only to be *pushed*, and pushing is what the SSE stream's sweep tick is for
 * (see server/routes/letters.js). Choosing read-time for the write means:
 *
 *   - no background timer exists between requests, so there is nothing to leak
 *     when the process wants to exit, and nothing to reason about after a restart;
 *   - a letter scheduled for 3am is promoted the moment anyone looks at 3am, with
 *     no dependence on a process having been alive at the exact moment;
 *   - it is idempotent. Running it twice changes nothing, so a retry, a
 *     re-read, or a client hammering the endpoint cannot corrupt anything.
 *
 * Both statements are scoped to the user so an unrelated reader does no writes,
 * and both are guarded by an index on (user, created_at).
 */
function reconcileStates(db, userId, now = nowInstant()) {
  ensureSchema(db);
  const at = canonicalInstant(now) ?? nowInstant();

  const run = db.transaction(() => {
    // 0. Repair instants that are still in a legacy shape. The legacy insert
    //    path (server/index.js) writes delivered_at straight from the request
    //    body, so rows can appear here that were never canonicalised. Selecting
    //    by length makes this a no-op scan in the steady state.
    const stray = db
      .prepare(
        `SELECT id, sent_at, created_at, delivered_at FROM letters
          WHERE created_at IS NULL
             OR length(created_at) <> 24
             OR (delivered_at IS NOT NULL AND length(delivered_at) <> 24)`,
      )
      .all();
    if (stray.length) {
      const fixCreated = db.prepare('UPDATE letters SET created_at = ? WHERE id = ?');
      const fixDelivered = db.prepare('UPDATE letters SET delivered_at = ? WHERE id = ?');
      for (const row of stray) {
        const created = canonicalInstant(row.created_at) ?? canonicalInstant(row.sent_at) ?? at;
        if (created !== row.created_at) fixCreated.run(created, row.id);
        const delivered = canonicalInstant(row.delivered_at);
        if (delivered !== row.delivered_at) fixDelivered.run(delivered, row.id);
      }
    }

    // 1. in_transit / sealed → opened, once delivered_at has passed.
    //    opened_at is the moment it became available; read_at is left alone
    //    because arriving is not the same as being read.
    db.prepare(
      `UPDATE letters
          SET state = 'opened',
              opened_at = COALESCE(opened_at, delivered_at)
        WHERE state IN ('sealed', 'in_transit')
          AND delivered_at IS NOT NULL
          AND delivered_at <= :now
          AND (sender_id = :uid OR recipient_id = :uid)`,
    ).run({ uid: userId, now: at });

    // 2. opened → replied, when the recipient has answered it.
    db.prepare(
      `UPDATE letters
          SET state = 'replied'
        WHERE state = 'opened'
          AND (sender_id = :uid OR recipient_id = :uid)
          AND EXISTS (
            SELECT 1 FROM letters r
             WHERE r.sender_id = letters.recipient_id
               AND r.recipient_id = letters.sender_id
               AND r.state <> 'draft'
               AND r.created_at > COALESCE(letters.delivered_at, letters.created_at)
          )`,
    ).run({ uid: userId });
  });

  run();
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * One page of the archive, newest first.
 *
 * The page is `limit + 1` rows so `hasMore` is a fact about the database rather
 * than an inference from "did I get exactly as many as I asked for" — which is
 * what makes the last page terminate correctly when the archive size happens to
 * be an exact multiple of the limit.
 */
function pageLetters(db, { userId, limit, cursor, now = nowInstant() } = {}) {
  ensureSchema(db);
  const at = canonicalInstant(now) ?? nowInstant();
  const size = clampLimit(limit);
  const decoded = decodeCursor(cursor);

  // Backwards paging. `created_at` is the tuple's major key; `id` breaks ties
  // inside one millisecond. A row inserted mid-scroll is strictly newer than any
  // cursor already handed out, so it lands above the boundary and can appear in
  // neither this page nor any later page.
  const older =
    decoded === null
      ? ''
      : decoded.createdAt === null
        ? ' AND l.id < :cId'
        : ' AND (l.created_at < :cAt OR (l.created_at = :cAt AND l.id < :cId))';

  const params = {
    uid: userId,
    now: at,
    cAt: decoded?.createdAt ?? null,
    cId: decoded?.id ?? null,
    limit: size + 1,
  };

  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM letters l
        WHERE ${VISIBLE}${older}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT :limit`,
    )
    .all(params);

  const hasMore = rows.length > size;
  const letters = hasMore ? rows.slice(0, size) : rows;
  const last = letters[letters.length - 1];

  return {
    letters,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

function getLetter(db, { letterId, userId, now = nowInstant() } = {}) {
  ensureSchema(db);
  const at = canonicalInstant(now) ?? nowInstant();
  return (
    db
      .prepare(`SELECT ${COLUMNS} FROM letters l WHERE l.id = :id AND ${VISIBLE}`)
      .get({ id: Number(letterId), uid: userId, now: at }) ?? null
  );
}

/**
 * Counts by state, for the archive's own summary line. Uses the same derived
 * expression as the projection, so the numbers cannot disagree with the list.
 */
function stateCounts(db, { userId, now = nowInstant() } = {}) {
  ensureSchema(db);
  const at = canonicalInstant(now) ?? nowInstant();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN ${DERIVED_STATE} = 'draft'       THEN 1 ELSE 0 END) AS draft,
         SUM(CASE WHEN ${DERIVED_STATE} = 'sealed'      THEN 1 ELSE 0 END) AS sealed,
         SUM(CASE WHEN ${DERIVED_STATE} = 'in_transit'  THEN 1 ELSE 0 END) AS in_transit,
         SUM(CASE WHEN ${DERIVED_STATE} = 'opened'      THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN ${DERIVED_STATE} = 'replied'     THEN 1 ELSE 0 END) AS replied
       FROM letters l WHERE ${VISIBLE}`,
    )
    .get({ uid: userId, now: at });
  return { total: row.total || 0, ...STATES.reduce((acc, s) => ({ ...acc, [s]: row[s] || 0 }), {}) };
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

const isPaired = (db, aId, bId) =>
  !!db.prepare('SELECT user_id FROM pairs WHERE user_id = ? AND partner_id = ?').get(aId, bId);

/**
 * The initial state of a letter at the moment it is created.
 *
 * `draft` is the caller's word and is honoured as-is. Otherwise: still travelling
 * if it is scheduled for later, sealed-but-not-yet-departed if it is going out
 * now. `createLetter` reconciles immediately afterwards, so an unscheduled letter
 * reaches `opened` inside the same transaction and no reader ever observes a
 * letter stuck in `sealed`.
 */
function initialState({ requested, deliveredAt, now }) {
  if (requested && STATES.includes(requested)) return requested;
  if (deliveredAt && deliveredAt > now) return 'in_transit';
  return 'sealed';
}

/**
 * Inserts one letter. Idempotent when given an idempotency key.
 *
 * The offline outbox (client/src/lib/sync.ts) mints one key per composed letter
 * and reuses it for every retry, so a request that timed out on the way to the
 * server — or that the server answered and the response was lost — cannot produce
 * a second row. The uniqueness is enforced by `idx_letters_idempotency`, not by
 * this code path; `INSERT OR IGNORE` plus a re-read inside one synchronous
 * transaction is what makes the check-then-write atomic without a serialisable
 * transaction.
 */
function createLetter(
  db,
  {
    senderId,
    recipientId,
    encryptedContent,
    encryptedMetadata = null,
    photoPaths = null,
    deliveredAt = null,
    repliedTo = null,
    idempotencyKey = null,
    requestedState = null,
    notify = true,
    now = nowInstant(),
  } = {},
) {
  ensureSchema(db);
  const at = canonicalInstant(now) ?? nowInstant();
  const requestedDue = canonicalInstant(deliveredAt);
  // An unscheduled letter is due immediately: `delivered_at` is the moment the
  // letter becomes available to the recipient, and for "right now" that is now.
  // Leaving it NULL would strand the letter in `sealed` forever, because
  // arrival is defined as delivered_at having passed.
  const due = requestedDue ?? (requestedState === 'draft' ? null : at);
  const state = initialState({ requested: requestedState, deliveredAt: due, now: at });

  const key = idempotencyKey === null || idempotencyKey === undefined ? null : String(idempotencyKey);

  const run = db.transaction(() => {
    if (key) {
      const existing = db
        .prepare('SELECT * FROM letters WHERE sender_id = ? AND idempotency_key = ?')
        .get(senderId, key);
      if (existing) return { row: existing, duplicate: true };
    }

    const info = db
      .prepare(
        `INSERT INTO letters
           (sender_id, recipient_id, encrypted_content, encrypted_metadata, photo_paths,
            sent_at, delivered_at, created_at, state, opened_at, replied_to, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        senderId,
        recipientId,
        encryptedContent,
        encryptedMetadata,
        photoPaths,
        at,
        due,
        at,
        state,
        state === 'draft' ? null : due,
        repliedTo,
        key,
      );

    // Auto-link a reply when the client did not name its parent: the newest
    // letter this sender has received. Two people, one conversation — answering
    // the last thing you were sent is what "reply" means here, and leaving
    // `replied_to` NULL would make the archive unable to show that thread.
    let parent = repliedTo;
    if (parent === null || parent === undefined) {
      const candidate = db
        .prepare(
          `SELECT id FROM letters
            WHERE recipient_id = :senderId AND sender_id = :recipientId AND state <> 'draft'
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get({ senderId, recipientId });
      if (candidate) {
        parent = candidate.id;
        db.prepare('UPDATE letters SET replied_to = ? WHERE id = ?').run(parent, info.lastInsertRowid);
      }
    }

    if (notify) {
      db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
        .run(recipientId, 'letter_received', 'New Letter', 'A letter has arrived in your archive.');
    }

    // Settle the machine immediately so the row the caller is about to read back
    // is already in its resting state.
    reconcileStates(db, senderId, at);

    return { row: db.prepare('SELECT * FROM letters WHERE id = ?').get(info.lastInsertRowid), duplicate: false };
  });

  return run();
}

/** How many letters a letter can legitimately answer. Shared with the route layer. */
function isValidReplyTarget(db, { repliedTo, senderId, recipientId }) {
  if (repliedTo === null || repliedTo === undefined) return true;
  const row = db.prepare('SELECT sender_id, recipient_id FROM letters WHERE id = ?').get(repliedTo);
  return !!row && row.sender_id === recipientId && row.recipient_id === senderId;
}

/**
 * Records that the recipient opened the letter.
 *
 * `opened_at` is arrival; `read_at` is a human actually reading it. They are
 * different facts and conflating them is how "opened" stops meaning anything.
 */
function markRead(db, { letterId, userId, now = nowInstant() } = {}) {
  ensureSchema(db);
  const at = canonicalInstant(now) ?? nowInstant();
  const run = db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE letters
            SET read_at = COALESCE(read_at, :now),
                state = CASE WHEN state = 'sealed' OR state = 'in_transit' THEN 'opened' ELSE state END,
                opened_at = COALESCE(opened_at, :now)
          WHERE id = :id AND recipient_id = :uid`,
      )
      .run({ id: Number(letterId), uid: userId, now: at });
    if (!info.changes) return null;
    return db.prepare('SELECT * FROM letters WHERE id = ?').get(Number(letterId));
  });
  return run();
}

/** Discards a draft. Only a draft — a sent letter is not editable by design. */
function deleteDraft(db, { letterId, userId } = {}) {
  ensureSchema(db);
  const info = db
    .prepare("DELETE FROM letters WHERE id = ? AND sender_id = ? AND state = 'draft'")
    .run(Number(letterId), userId);
  return info.changes > 0;
}

/** Replaces a draft's envelope in place. */
function updateDraft(db, { letterId, userId, encryptedContent, encryptedMetadata = null } = {}) {
  ensureSchema(db);
  const info = db
    .prepare(
      `UPDATE letters
          SET encrypted_content = ?, encrypted_metadata = COALESCE(?, encrypted_metadata)
        WHERE id = ? AND sender_id = ? AND state = 'draft'`,
    )
    .run(encryptedContent, encryptedMetadata, Number(letterId), userId);
  return info.changes > 0;
}

module.exports = {
  STATES,
  LIFECYCLE_RANK,
  MAX_PAGE,
  DEFAULT_PAGE,
  canonicalInstant,
  nowInstant,
  ensureSchema,
  encodeCursor,
  decodeCursor,
  reconcileStates,
  pageLetters,
  getLetter,
  stateCounts,
  createLetter,
  isPaired,
  isValidReplyTarget,
  markRead,
  deleteDraft,
  updateDraft,
};