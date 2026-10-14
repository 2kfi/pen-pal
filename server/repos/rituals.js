/**
 * Ritual storage.
 *
 * Everything here is deliberately dumb. It stores envelopes, returns envelopes,
 * and derives two facts it already owns (when you paired, which UTC days a
 * letter crossed). It never sees a plaintext answer and it cannot grade one.
 *
 * The single most important property in this file: `pairKeyFor()` is derived from
 * the authenticated user's `pairs` row, never from a request body. A caller
 * cannot address another pair's puzzle or ledger by guessing a key.
 */

// Path matters: this module lives in server/repos/, and the migration was
// renumbered 050 -> 060 when two agents independently claimed version 030 and
// then 050. Requiring a migration by *number* couples this file to that
// numbering, so the lookup goes through the runner's own listing instead.
const MIGRATIONS = require('../lib/migrations');

function ritualsMigration() {
  const found = MIGRATIONS.listMigrations().find((m) => m.name === 'rituals');
  if (!found) {
    throw new Error(
      'the rituals migration is missing from server/lib/migrations/ — ' +
        'no file there exports { name: "rituals" }',
    );
  }
  return found;
}

/**
 * SQLite's `CURRENT_TIMESTAMP` writes "YYYY-MM-DD HH:MM:SS" in **UTC** with no
 * zone marker. `new Date("2026-10-13 20:37:00")` is parsed as *local* time by
 * every engine, which would silently shift day boundaries for anyone not on UTC
 * — the exact bug the streak ritual exists to avoid.
 *
 * So: a timestamp that carries an explicit zone is parsed normally; one that
 * does not is a SQLite UTC stamp and its first ten characters ARE the UTC date.
 */
function utcDay(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(timestamp);
  if (hasZone) {
    const d = new Date(timestamp);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return /^\d{4}-\d{2}-\d{2}/.test(timestamp) ? timestamp.slice(0, 10) : null;
}

/** Today's UTC calendar day. The puzzle's clock, for both people at once. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Today's UTC day, or yesterday's: someone at UTC+13 answers just after their
 *  local midnight and must not be told their puzzle has expired. */
function acceptedDays(now = new Date()) {
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  return new Set([todayStr, yesterday]);
}

module.exports = function ritualRepo(db) {
  const ensured = { done: false };

  /**
   * Idempotent. Called on every request rather than at boot because index.js
   * owns the app lifecycle and a route module must not depend on having been
   * mounted before the first request lands.
   */
  function ensureSchema() {
    if (ensured.done) return;
    ritualsMigration().up(db);
    ensured.done = true;
  }

  /** Canonical pair identifier: the two user ids, ascending. "7-11". */
  function pairKeyFor(userId) {
    const row = db
      .prepare('SELECT partner_id, created_at FROM pairs WHERE user_id = ?')
      .get(userId);
    if (!row) return null;
    const lo = Math.min(userId, row.partner_id);
    const hi = Math.max(userId, row.partner_id);
    return {
      pairKey: `${lo}-${hi}`,
      userId,
      partnerId: row.partner_id,
      pairedAt: row.created_at,
    };
  }

  /**
   * The two UTC days a letter crossed, plus the earliest one.
   *
   * Drawn from `letters.sent_at`, which the server has always held in the clear
   * as letter metadata. The ritual adds no new exposure here; what it *does* seal
   * is the ledger the client derives from these days (see ritual_ledgers).
   *
   * Two kinds of row are deliberately NOT counted, because a day that carried
   * no letter is the one thing a streak must never invent:
   *
   *   - a draft. `state = 'draft'` means it was never sent, so it crossed
   *     nothing. Counting it would put a mark on a day where the partner has
   *     nothing to open, and it would be the only mark of that day.
   *   - a future day. A scheduled letter carries a `sent_at` in the future; its
   *     UTC day would land on a cell the reader has not reached yet and would
   *     report a streak "ending" next Thursday. The cutoff is applied here to
   *     the already-parsed YYYY-MM-DD rather than in SQL, because `sent_at`
   *     mixes SQLite's space-separated UTC stamp with ISO-8601 in older rows and
   *     a lexical comparison across those two silently lies.
   */
  function letterDays(pairKey, userId, partnerId) {
    const rows = db
      .prepare(
        `SELECT sent_at FROM letters
         WHERE ((sender_id = ? AND recipient_id = ?)
            OR (sender_id = ? AND recipient_id = ?))
           AND sent_at IS NOT NULL
           AND state <> 'draft'
         ORDER BY sent_at ASC`,
      )
      .all(userId, partnerId, partnerId, userId);

    const cutoff = today();
    const days = [];
    let firstLetterAt = null;
    for (const row of rows) {
      const day = utcDay(row.sent_at);
      if (!day || day > cutoff) continue;
      if (!firstLetterAt) firstLetterAt = row.sent_at;
      if (days[days.length - 1] !== day) days.push(day);
    }
    return { days, firstLetterAt };
  }

  /** Both rows for a pair/day, plus whether both sides have answered. */
  function puzzle(pairKey, day) {
    const rows = db
      .prepare(
        `SELECT user_id, encrypted_answer, created_at FROM ritual_puzzles
         WHERE pair_key = ? AND day = ?`,
      )
      .all(pairKey, day);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    return { byUser, both: byUser.size === 2 };
  }

  /** One answer a day per person. Returns the stored row. */
  function putPuzzleAnswer(pairKey, day, userId, encryptedAnswer) {
    db.prepare(
      `INSERT INTO ritual_puzzles (pair_key, day, user_id, encrypted_answer)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(pair_key, day, user_id) DO UPDATE SET encrypted_answer = excluded.encrypted_answer`,
    ).run(pairKey, day, userId, encryptedAnswer);
    return db
      .prepare(
        `SELECT user_id, encrypted_answer, created_at FROM ritual_puzzles
         WHERE pair_key = ? AND day = ? AND user_id = ?`,
      )
      .get(pairKey, day, userId);
  }

  function getLedger(pairKey, userId) {
    return (
      db
        .prepare('SELECT encrypted_state, updated_at FROM ritual_ledgers WHERE pair_key = ? AND user_id = ?')
        .get(pairKey, userId) ?? null
    );
  }

  function putLedger(pairKey, userId, encryptedState) {
    db.prepare(
      `INSERT INTO ritual_ledgers (pair_key, user_id, encrypted_state)
       VALUES (?, ?, ?)
       ON CONFLICT(pair_key, user_id) DO UPDATE SET
         encrypted_state = excluded.encrypted_state,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(pairKey, userId, encryptedState);
    return getLedger(pairKey, userId);
  }

  return {
    ensureSchema,
    pairKeyFor,
    letterDays,
    puzzle,
    putPuzzleAnswer,
    getLedger,
    putLedger,
    /** Exported for the route's validation and for tests. */
    _internals: { utcDay, today, acceptedDays },
  };
};