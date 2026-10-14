/**
 * 020 — reshape `pairs` from "one row per relationship" to "one row per user".
 *
 * ## The shape change
 *
 * v0.0.2:  pairs(id INTEGER PRIMARY KEY AUTOINCREMENT, user1_id, user2_id)
 * v2:      pairs(user_id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL)
 *
 * v0.0.2 had no uniqueness anywhere on that table, so one account could hold any
 * number of partners and `SELECT * FROM pairs WHERE user1_id = ? OR user2_id = ?`
 * returned whichever row the query planner liked first — which is how a letter
 * could be delivered to the wrong person. `user_id` as the PRIMARY KEY turns
 * "one partner at a time" into something the storage engine enforces.
 *
 * ## Why this is destructive-looking but is not
 *
 * `ALTER TABLE ... RENAME` + `CREATE` + `INSERT` looks like the kind of thing
 * that eats a database. Three things make it safe here:
 *
 *   1. The runner wrapped this whole function in ONE transaction. A failure at
 *      any point rolls the file back to the pre-migration bytes.
 *   2. The old table is RENAMED, never dropped. It survives as
 *      `pairs_legacy_v002` with every original row intact, so even a successful
 *      migration leaves the source data on disk for as long as anyone wants it.
 *      See docs/MIGRATION.md for when it is safe to drop.
 *   3. The pre-migration snapshot the runner takes for any populated database.
 *
 * ## What it does with a user who had two partners
 *
 * That is not hypothetical: v0.0.2 permitted it. `user_id` is a primary key, so
 * one row per user is all that fits. The rule is "lowest legacy row id wins" —
 * deterministic, order-independent of SQLite's query planner, and the same
 * result on every machine that runs this. Every discarded pairing is logged by
 * user id, at `warn`, with both candidates, so an operator can go and re-pair
 * that account deliberately instead of discovering it from a missing letter.
 *
 * A self-pairing (user1_id === user2_id) cannot survive the reshape and is
 * logged rather than silently dropped.
 */

const NEW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pairs (
  user_id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

const INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_pairs_partner ON pairs(partner_id);';

const LEGACY_TABLE = 'pairs_legacy_v002';

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

/** Reads the legacy rows in a stable, planner-independent order. */
function readLegacyRows(db, cols) {
  const order = cols.includes('id') ? 'id ASC' : 'rowid ASC';
  const idExpr = cols.includes('id') ? 'id' : 'rowid';
  const createdExpr = cols.includes('created_at') ? 'created_at' : 'NULL';
  return db
    .prepare(
      `SELECT ${idExpr} AS legacy_id, user1_id, user2_id, ${createdExpr} AS created_at
       FROM pairs ORDER BY ${order}`,
    )
    .all();
}

/**
 * Converts the legacy table in place. Assumes we are inside the runner's
 * transaction and that `pairs` still has the old shape.
 */
function convertLegacyTable(db, logger) {
  const cols = columnsOf(db, 'pairs');
  const rows = readLegacyRows(db, cols);

  // Renaming, not dropping. This is the whole reason the migration is reversible.
  db.exec(`ALTER TABLE pairs RENAME TO ${LEGACY_TABLE};`);
  db.exec(NEW_TABLE_SQL);

  const insert = db.prepare('INSERT INTO pairs (user_id, partner_id, created_at) VALUES (?, ?, ?)');
  const fallbackCreated = new Date().toISOString();

  // `partnerOf` doubles as the "is this user already taken" set: a Map keyed by
  // user_id is the PRIMARY KEY, spelled out.
  const partnerOf = new Map();
  const dropped = [];
  const selfPairs = [];
  const invalid = [];
  let inserted = 0;

  for (const row of rows) {
    const created = row.created_at || fallbackCreated;

    for (const [userId, partnerId] of [
      [row.user1_id, row.user2_id],
      [row.user2_id, row.user1_id],
    ]) {
      if (!Number.isInteger(userId) || !Number.isInteger(partnerId)) {
        // v0.0.2 declared these NOT NULL but nothing enforced it and the
        // original sql.js write path did not check. Keep the finding, skip the row.
        invalid.push({ legacy_id: row.legacy_id, user1_id: row.user1_id, user2_id: row.user2_id });
        logger.warn('skipping a legacy pairing with a non-integer id', {
          migration: '020',
          legacy_id: row.legacy_id,
          user1_id: row.user1_id,
          user2_id: row.user2_id,
        });
        continue;
      }

      if (userId === partnerId) {
        selfPairs.push({ user_id: userId, legacy_id: row.legacy_id });
        logger.warn('dropping a legacy self-pairing, which cannot be represented', {
          migration: '020',
          user_id: userId,
          legacy_id: row.legacy_id,
        });
        continue;
      }

      const held = partnerOf.get(userId);
      if (held !== undefined) {
        // The conflict the brief cares about. Keep the earliest legacy row.
        dropped.push({ user_id: userId, kept_partner: held, dropped_partner: partnerId, legacy_id: row.legacy_id });
        logger.warn('user had more than one partner; keeping the earliest and dropping the rest', {
          migration: '020',
          user_id: userId,
          kept_partner: held,
          dropped_partner: partnerId,
          legacy_id: row.legacy_id,
        });
        continue;
      }

      insert.run(userId, partnerId, created);
      partnerOf.set(userId, partnerId);
      inserted += 1;
    }
  }

  db.exec(INDEX_SQL);

  // The old schema had no foreign keys, so a partner_id can point at a user that
  // no longer exists. Keeping the row is the honest choice — dropping it is data
  // loss — but the operator needs to hear about it.
  const dangling = db
    .prepare(
      `SELECT p.user_id, p.partner_id FROM pairs p
       LEFT JOIN users u ON u.id = p.partner_id
       WHERE u.id IS NULL`,
    )
    .all();
  for (const d of dangling) {
    logger.warn('pairing points at a user that does not exist; kept, but it is inert', {
      migration: '020',
      user_id: d.user_id,
      partner_id: d.partner_id,
    });
  }

  const summary = {
    kind: 'pairs_reshaped',
    legacy_rows: rows.length,
    rows_written: inserted,
    users_paired: partnerOf.size,
    legacy_table_kept_as: LEGACY_TABLE,
    dropped_multi_partner: dropped.length,
    dropped_self_pairings: selfPairs.length,
    skipped_invalid: invalid.length,
    dangling_partner_refs: dangling.length,
  };

  if (dropped.length) {
    logger.warn(
      `${dropped.length} account(s) had more than one partner in v0.0.2 and now have exactly one. ` +
        'Re-pair them by hand if the kept partner is not the right one.',
      { ...summary, affected_users: dropped.map((d) => d.user_id) },
    );
  }

  return summary;
}

module.exports = {
  name: 'pairs-user-id-primary-key',
  LEGACY_TABLE,

  up(db, ctx = {}) {
    const logger = ctx.logger || { warn() {}, info() {} };

    if (!tableExists(db, 'pairs')) {
      // Fresh install. Nothing to convert.
      db.exec(NEW_TABLE_SQL);
      db.exec(INDEX_SQL);
      return { kind: 'pairs_created' };
    }

    const cols = columnsOf(db, 'pairs');
    const isNew = cols.includes('user_id') && cols.includes('partner_id');
    const isLegacy = cols.includes('user1_id') && cols.includes('user2_id');

    if (isNew) {
      // Already the current shape — a v2 database the ledger has simply never
      // seen (every existing v2 install, on its first boot of the runner).
      // Must stay a no-op on the DATA, or that is exactly the data loss this
      // whole exercise exists to prevent.
      db.exec(INDEX_SQL);
      const count = db.prepare('SELECT COUNT(*) AS n FROM pairs').get().n;
      return { kind: 'pairs_already_current', rows_untouched: count };
    }

    if (isLegacy) {
      return convertLegacyTable(db, logger);
    }

    // A `pairs` table in neither shape. We do not know what this is, so we do
    // not destroy it: rename it out of the way and build the real one. The app
    // works, and the bytes are still on disk for whoever has to look.
    const parked = `${LEGACY_TABLE}_unrecognised`;
    let finalName = parked;
    let n = 2;
    while (tableExists(db, finalName)) {
      finalName = `${parked}_${n++}`;
    }
    db.exec(`ALTER TABLE pairs RENAME TO ${finalName};`);
    db.exec(NEW_TABLE_SQL);
    db.exec(INDEX_SQL);
    logger.error('pairs table was in a shape this migration does not recognise; preserved it untouched', {
      migration: '020',
      columns: cols,
      preserved_as: finalName,
    });
    return { kind: 'pairs_unrecognised_shape', columns: cols, preserved_as: finalName };
  },
};
