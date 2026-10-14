'use strict';

/**
 * Plan step 9 — the letter lifecycle, as storage.
 *
 * `letters` had exactly one lifecycle column (`delivered_at`) and nothing else,
 * so "draft → sealed → in transit → opened → replied" existed nowhere except in
 * docs/DESIGN.md §5. This migration makes the journey a database fact:
 *
 *   state       TEXT  NOT NULL CHECK (state IN ('draft','sealed','in_transit','opened','replied'))
 *   opened_at   TEXT  when the letter became AVAILABLE to the recipient
 *   read_at     TEXT  when the recipient actually opened it (read receipts)
 *   replied_to  INTEGER REFERENCES letters(id)   the letter this one answers
 *   created_at  TEXT  row existence order — the cursor key (NOT sent_at)
 *   idempotency_key TEXT  offline-outbox de-duplication
 *
 * Two deliberate choices:
 *
 * 1. `created_at` rather than `sent_at`. `sent_at` is what the *author* says the
 *    letter was written at; the paging cursor must key on when the row came into
 *    existence or a backdated letter reorders under a scroll. They are equal for
 *    everything this app writes, and copying one into the other is the backfill.
 *
 * 2. Every instant is normalised to a FIXED-WIDTH canonical form,
 *    `YYYY-MM-DDTHH:MM:SS.mmmZ`, on the way in and on the way out. The legacy
 *    table mixes SQLite's `YYYY-MM-DD HH:MM:SS` (space, from `DEFAULT
 *    CURRENT_TIMESTAMP`) with the ISO-8601 `…T…Z` strings the client sends. Lexical
 *    comparison of those two silently lies: `'2026-10-13 09:00:00' <=
 *    '2026-10-13T09:00:01.000Z'` is TRUE because `' ' < 'T'`, which is how a
 *    scheduled letter would be delivered the moment it was written. Normalising
 *    makes every comparison in the codebase an honest one, and it keeps
 *    `delivered_at <= ?` usable by an index instead of by a julianday() call.
 *
 * `replied` is NOT a column the caller sets. It is derived (see
 * server/repos/letters.js — `reconcileStates`): a letter is replied when the
 * recipient has sent something after it became available to them. The column is a
 * materialised cache of that fact, and the trigger below is the only thing that
 * stops it drifting backwards.
 */

const NAME = 'letter-states';

const STATES = ['draft', 'sealed', 'in_transit', 'opened', 'replied'];

/** Lifecycle rank. A letter may only ever move forward through this. */
const RANK = { draft: 0, sealed: 1, in_transit: 2, opened: 3, replied: 4 };

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Coerces anything date-shaped into the canonical fixed-width UTC instant.
 * Returns null for absent/unparseable values rather than throwing, so a bad
 * `delivered_at` degrades to "arrives immediately" instead of a 500.
 */
function canonicalInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;

  const raw = String(value).trim();
  if (!raw) return null;

  // A space-separated SQLite timestamp is UTC; an ISO string carries its own
  // offset. Only the former needs the 'Z' bolted on.
  let candidate = raw.replace(' ', 'T');
  if (!OFFSET_SUFFIX.test(candidate)) candidate += 'Z';

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function rankSql(alias) {
  return `CASE ${alias}.state WHEN 'draft' THEN 0 WHEN 'sealed' THEN 1 WHEN 'in_transit' THEN 2 WHEN 'opened' THEN 3 WHEN 'replied' THEN 4 ELSE 0 END`;
}

function up(db) {
  db.transaction(() => {
    const before = new Set(
      db.prepare("SELECT name FROM pragma_table_info('letters')").all().map((c) => c.name),
    );
    const has = (name) => before.has(name);

    // --- columns -------------------------------------------------------------
    // Each guarded: a database that already has the column (because a newer
    // db.js ran this migration, or because the repo's own ensureSchema did) is
    // left alone instead of failing on a duplicate column.
    if (!has('state')) {
      db.exec(
        `ALTER TABLE letters ADD COLUMN state TEXT NOT NULL DEFAULT 'opened'
           CHECK (state IN (${STATES.map((s) => `'${s}'`).join(',')}))`,
      );
    }
    if (!has('opened_at')) db.exec('ALTER TABLE letters ADD COLUMN opened_at TEXT');
    if (!has('read_at')) db.exec('ALTER TABLE letters ADD COLUMN read_at TEXT');
    if (!has('replied_to')) db.exec('ALTER TABLE letters ADD COLUMN replied_to INTEGER REFERENCES letters(id)');
    if (!has('created_at')) db.exec('ALTER TABLE letters ADD COLUMN created_at TEXT');
    if (!has('idempotency_key')) db.exec('ALTER TABLE letters ADD COLUMN idempotency_key TEXT');

    // --- backfill ------------------------------------------------------------
    const now = new Date().toISOString();

    if (!has('created_at')) {
      // Same instant, canonical shape. Rows written by the legacy insert path
      // (which never wrote created_at) are repaired here and again lazily by
      // the repo, so the cursor key is never NULL for any row.
      const rows = db.prepare('SELECT id, sent_at, created_at FROM letters').all();
      const fix = db.prepare('UPDATE letters SET created_at = ? WHERE id = ?');
      for (const row of rows) {
        const created = canonicalInstant(row.created_at) ?? canonicalInstant(row.sent_at) ?? now;
        if (created !== row.created_at) fix.run(created, row.id);
      }
    }

    if (!has('state')) {
      // "Sensibly": anything already sitting in the postbox with a delivery date
      // still in the future is travelling; everything else has, by definition,
      // already landed. There are no drafts and nothing is unread yet.
      db.prepare(
        `UPDATE letters
            SET state = CASE WHEN delivered_at IS NOT NULL AND delivered_at > ? THEN 'in_transit'
                             ELSE 'opened' END`,
      ).run(now);
    }

    if (!has('opened_at')) {
      db.prepare(
        `UPDATE letters SET opened_at = delivered_at
          WHERE delivered_at IS NOT NULL AND delivered_at <= ?`,
      ).run(now);
    }

    // Normalise whatever instants are still in a legacy shape, so the lexical
    // comparisons above and below are meaningful for every row in the table.
    const stray = db
      .prepare(
        `SELECT id, sent_at, created_at, delivered_at FROM letters
          WHERE created_at IS NULL
             OR length(created_at) <> 24
             OR delivered_at IS NOT NULL AND length(delivered_at) <> 24`,
      )
      .all();
    const fixCreated = db.prepare('UPDATE letters SET created_at = ? WHERE id = ?');
    const fixDelivered = db.prepare('UPDATE letters SET delivered_at = ? WHERE id = ?');
    for (const row of stray) {
      const created = canonicalInstant(row.created_at) ?? canonicalInstant(row.sent_at) ?? now;
      if (created !== row.created_at) fixCreated.run(created, row.id);
      const delivered = canonicalInstant(row.delivered_at);
      if (delivered !== row.delivered_at) fixDelivered.run(delivered, row.id);
    }

    // --- indexes -------------------------------------------------------------
    // Two of them, not one on (sender_id, recipient_id): the visibility rule is
    // an OR, and SQLite can only satisfy an OR with an index it can seek into,
    // so each side of the OR needs its own (created_at DESC, id DESC) feed.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_letters_sender_feed
         ON letters (sender_id, created_at DESC, id DESC)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_letters_recipient_feed
         ON letters (recipient_id, created_at DESC, id DESC)`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_letters_idempotency
         ON letters (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    );

    // --- the one-way ratchet -------------------------------------------------
    // Created LAST, after the backfill, because the backfill legitimately moves
    // rows from the DEFAULT 'opened' (rank 3) down to 'in_transit' (rank 2).
    db.exec(`DROP TRIGGER IF EXISTS trg_letters_state_forward`);
    db.exec(`
      CREATE TRIGGER trg_letters_state_forward
        BEFORE UPDATE OF state ON letters
        WHEN NEW.state IS NOT OLD.state
         AND (${rankSql('NEW')}) < (${rankSql('OLD')})
      BEGIN
        SELECT RAISE(ABORT, 'letters.state cannot move backwards');
      END`);
  })();
}

module.exports = { name: NAME, up, canonicalInstant, STATES, RANK };