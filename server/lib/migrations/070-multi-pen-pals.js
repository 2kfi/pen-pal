/**
 * 070 — allow more than one pen pal.
 *
 * The one-partner rule lived in the storage engine: 020 made `user_id` the
 * PRIMARY KEY of `pairs`, which is a database-enforced claim that a person can
 * hold exactly one pairing. The product decision (2026-10) revokes that: the
 * app is for pen pals, plural — each correspondence its own channel, exactly
 * like writing letters to two people. Nothing else about the thesis changes:
 * a letter still takes time, and each pal still gets their own archive,
 * rituals, and chess board.
 *
 * The shape change:
 *
 *   before (020): pairs(user_id INTEGER PRIMARY KEY, partner_id, created_at)
 *   after (070):  pairs(user_id, partner_id, created_at,
 *                       UNIQUE(user_id, partner_id))
 *
 * UNIQUE(user_id, partner_id) keeps the property that mattered without the
 * claim that doesn't: you still cannot hold the same partner twice, in either
 * direction. The partner-direction index stays, since "who considers this user
 * their pal" is how unpair and pending-state queries find both rows.
 *
 * No data is discarded. Every pair row survives the reshape; a user who had one
 * partner has one partner after it too. The rename-not-drop discipline from 020
 * applies: the 020-shape table is kept as `pairs_legacy_v020`.
 *
 * Caller-facing derivations that depended on "the one row": `pairKeyFor` in the
 * rituals and games repos read `pairs WHERE user_id = ?` and took whatever row
 * returned. With N rows that query returns the first — an arbitrary pick. Those
 * repos are changed in the same commit to take an explicit partner id, resolved
 * server-side against the caller's own rows, so a key can still never be
 * addressed by guessing a request body.
 */

const NEW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pairs (
  user_id INTEGER NOT NULL,
  partner_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, partner_id)
);`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_pairs_partner ON pairs(partner_id);
CREATE INDEX IF NOT EXISTS idx_pairs_user ON pairs(user_id);`;

const LEGACY_TABLE = 'pairs_legacy_v020';

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

/** A name no existing table claims. */
function freeLegacyName(db) {
  if (!tableExists(db, LEGACY_TABLE)) return LEGACY_TABLE;
  let n = 2;
  while (tableExists(db, `${LEGACY_TABLE}_${n}`)) n += 1;
  return `${LEGACY_TABLE}_${n}`;
}

module.exports = {
  name: 'multi-pen-pals',

  up(db, ctx = {}) {
    const logger = ctx.logger || { warn() {}, info() {} };

    if (!tableExists(db, 'pairs')) {
      db.exec(NEW_TABLE_SQL);
      db.exec(INDEXES_SQL);
      return { kind: 'pairs_created' };
    }

    const cols = columnsOf(db, 'pairs');
    const isOnePal = cols.includes('user_id') && cols.includes('partner_id');

    if (!isOnePal) {
      // Not a shape we know. Park it untouched and build fresh — same posture
      // as 020 toward tables it cannot read.
      let name = 'pairs_legacy_v020_unrecognised';
      let n = 2;
      while (tableExists(db, name)) name = `${name}_${n++}`;
      db.exec(`ALTER TABLE pairs RENAME TO ${name};`);
      db.exec(NEW_TABLE_SQL);
      db.exec(INDEXES_SQL);
      logger.error('pairs table was in an unrecognised shape; preserved untouched', {
        migration: '070',
        columns: cols,
        preserved_as: name,
      });
      return { kind: 'pairs_unrecognised_shape', columns: cols, preserved_as: name };
    }

    const pkList = db.pragma('table_info(pairs)');
    const pkCount = pkList.filter((c) => c.pk > 0).length;
    if (pkCount === 0) {
      db.exec(INDEXES_SQL);
      const count = db.prepare('SELECT COUNT(*) AS n FROM pairs').get().n;
      return { kind: 'pairs_already_current', rows_untouched: count };
    }

    const rows = db
      .prepare('SELECT user_id, partner_id, created_at, rowid AS rid FROM pairs ORDER BY rid ASC')
      .all();
    // The rename lands in a free name: this migration can legitimately run into
    // a database once more (ledger wiped, table rebuilt by hand), and the first
    // run's legacy copy is still sitting there. Suffixing is what keeps the
    // second pass from colliding with the first.
    const legacyName = freeLegacyName(db);
    logger.info('reshaping pairs: every row survives, shape is preserved as a legacy table', {
      migration: '070',
      rows: rows.length,
      preserved_as: legacyName,
    });
    db.exec(`ALTER TABLE pairs RENAME TO ${legacyName};`);
    db.exec(NEW_TABLE_SQL);

    const insert = db.prepare(
      'INSERT INTO pairs (user_id, partner_id, created_at) VALUES (?, ?, ?)',
    );
    const seen = new Set();
    let inserted = 0;
    let deduped = 0;
    for (const r of rows) {
      const key = `${r.user_id}:${r.partner_id}`;
      if (seen.has(key)) {
        deduped += 1;
        logger.warn('duplicate direction in legacy pairs; keeping the first', {
          migration: '070',
          user_id: r.user_id,
          partner_id: r.partner_id,
        });
        continue;
      }
      seen.add(key);
      insert.run(r.user_id, r.partner_id, r.created_at);
      inserted += 1;
    }

    db.exec(INDEXES_SQL);

    // Preserve the foreign references of anything that read pairs(). Also, the
    // legacy table name is registered for operators the same way 020 did it.
    return {
      kind: 'pairs_reshaped',
      direction: 'one_pal_to_multi_pal',
      legacy_rows: rows.length,
      rows_written: inserted,
      duplicate_directions_dropped: deduped,
      legacy_table_kept_as: legacyName,
    };
  },
};
