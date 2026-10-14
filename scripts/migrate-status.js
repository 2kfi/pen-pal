#!/usr/bin/env node
/**
 * `npm run migrate:status` — what is applied, what is pending, on the database
 * as it is on disk right now.
 *
 * Read-only: it never migrates, never opens the database read-write, and never
 * takes a pre-migration snapshot. Safe to run against a live instance while it
 * is serving.
 *
 * Exit codes, so this is usable from a deploy script:
 *   0  schema is up to date
 *   1  migrations are pending, or the database could not be read
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const Database = require(path.join(REPO_ROOT, 'node_modules/better-sqlite3'));

const dataDir = process.env.DATA_DIR || path.join(REPO_ROOT, 'server/data');
const dbFile = path.join(dataDir, 'penpal.db');

function out(msg) {
  process.stdout.write(`${msg}\n`);
}

if (!fs.existsSync(dbFile)) {
  out(`no database at ${dbFile}`);
  out('nothing to report. The schema is created on first boot.');
  process.exit(1);
}

// Read-only so that running this cannot itself change what it is reporting.
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

let status;
try {
  const { migrationStatus } = require(path.join(REPO_ROOT, 'server/lib/migrations/index.js'));
  status = migrationStatus(db);
} catch (err) {
  out(`could not read the migration ledger: ${err.message}`);
  db.close();
  process.exit(1);
}

const pairsCols = db.pragma('table_info(pairs)').map((c) => c.name);
const pairsShape = pairsCols.includes('user_id')
  ? 'current (user_id -> partner_id)'
  : pairsCols.includes('user1_id')
    ? 'v0.0.2 (user1_id, user2_id) — NOT YET MIGRATED'
    : `unrecognised: ${pairsCols.join(', ') || '(no columns)'}`;

const counts = {};
for (const t of ['users', 'pairs', 'letters', 'pairings', 'notifications', 'photos']) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (exists) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
}

out(dbFile);
out(`  integrity_check   ${db.pragma('quick_check', { simple: true })}`);
out(`  pairs shape       ${pairsShape}`);
out(`  ledger            ${status.applied_count}/${status.count} applied`);
out(`  current/latest    ${status.current} / ${status.latest}`);
out(`  pending           ${status.pending.length ? status.pending.join(', ') : 'none'}`);
out(
  `  rows              ${Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`,
);

const legacyExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pairs_legacy_v002'")
  .get();
if (legacyExists) {
  out(
    `  legacy table      pairs_legacy_v002 (${
      db.prepare('SELECT COUNT(*) AS n FROM pairs_legacy_v002').get().n
    } rows) — safe to drop once you are happy; see docs/MIGRATION.md`,
  );
}

db.close();

out('');
out(status.ok ? 'schema is up to date.' : 'MIGRATIONS ARE PENDING — start the server to apply them.');
process.exit(status.ok ? 0 : 1);