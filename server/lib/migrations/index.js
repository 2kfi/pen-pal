/**
 * A migration runner.
 *
 * ## Why this exists
 *
 * Until now `server/db.js` ran one `CREATE TABLE IF NOT EXISTS` blob on every
 * boot and called it a day. That works exactly once: for a database that does
 * not exist yet. For an existing one it silently does nothing, which is fine
 * for additive columns and catastrophic for a *reshape*.
 *
 * The concrete disaster: v0.0.2 stored `pairs(id, user1_id, user2_id)`. v2
 * stores `pairs(user_id PRIMARY KEY, partner_id)`. `CREATE TABLE IF NOT EXISTS`
 * does not touch the existing table, so an upgrading instance kept the OLD
 * shape forever and every pairing query — `SELECT user_id FROM pairs WHERE
 * user_id = ?` — threw "no such column: user_id". The data was never lost; the
 * app was simply permanently broken with no way to recover it, and no record
 * anywhere saying which shape the file on disk actually was.
 *
 * So: a versioned runner with a ledger. Applied versions are recorded in
 * `_migrations`, each migration runs inside one transaction together with its
 * own ledger row, and a version is never applied twice.
 *
 * ## Contract for a migration file
 *
 *   // server/lib/migrations/NNN-short-name.js
 *   module.exports = {
 *     name: 'short-name',
 *     up(db) { db.exec('...'); },
 *   };
 *
 * Rules, all of which the runner depends on:
 *
 *   - `db` is a better-sqlite3 handle. `up` runs RAW SQL.
 *   - Do NOT open or close your own transaction. The runner already wrapped the
 *     call in one, and better-sqlite3 refuses `BEGIN` inside a transaction.
 *     If you need a savepoint, `db.exec('SAVEPOINT x')` is fine.
 *   - `up(db, ctx)` may take a second argument, `{ logger, version, name }`.
 *     Optional; `up(db)` on its own is valid. Return a plain object to have it
 *     merged into the "migration applied" log line — useful for a migration that
 *     had to make a judgement call somebody should know about.
 *   - Filenames are `NNN-short-name.js`. The runner picks up whatever is in this
 *     directory at boot; dropping in a new file requires no edit here.
 *   - Lower numbers run first. `_migrations` is a ledger, not a queue — a
 *     migration already applied is never re-applied, so renumbering a shipped
 *     migration is a silent no-op rather than a re-run.
 *   - There is no automatic `down`. Rolling back means restoring a backup; see
 *     docs/MIGRATION.md. A migration MAY export `down(db)` for humans, but the
 *     runner will not call it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = __dirname;
const MIGRATIONS_TABLE = '_migrations';

/** `NNN-short-name.js` -> version "NNN", name "short-name". */
const FILE_RE = /^(\d{3})-([a-z0-9][a-z0-9-]*)\.js$/;

/** Guards against a re-entrant call (boot + an admin route, say). */
let running = false;

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function ensureMigrationsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    duration_ms INTEGER
  );`);
}

/**
 * Reads this directory and returns every migration, oldest first.
 *
 * Anything that is not a `NNN-name.js` file is ignored, which is what lets
 * `index.js` (this file) live in the same directory.
 */
function listMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => FILE_RE.test(f))
    .sort(); // zero-padded 3-digit names sort lexicographically == numerically

  // Two files claiming the same version silently breaks the ledger: `version` is
  // the PRIMARY KEY of _migrations, so the second one either fails mid-apply or
  // is recorded as already-applied and silently never runs. This happened for
  // real — two agents independently both chose 030. Fail at load instead, with a
  // message that says how to fix it.
  const seen = new Map();
  for (const file of files) {
    const version = FILE_RE.exec(file)[1];
    if (seen.has(version)) {
      throw new Error(
        `Duplicate migration version ${version}: ${seen.get(version)} and ${file}. ` +
          'Versions are the _migrations primary key and must be unique — renumber the newer file.',
      );
    }
    seen.set(version, file);
  }

  return files.map((file) => {
    const match = FILE_RE.exec(file);
    const version = match[1];
    const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(path.join(MIGRATIONS_DIR, file));

    if (typeof mod.up !== 'function') {
      throw new Error(`Migration ${file} must export an { name, up(db) } object with an up() function`);
    }

    return {
      version,
      name: mod.name || match[2],
      file,
      checksum: crypto.createHash('sha256').update(source).digest('hex'),
      up: mod.up,
      down: typeof mod.down === 'function' ? mod.down : undefined,
    };
  });
}

/** Every row in the ledger, keyed by version. `{}` if the table does not exist yet. */
function appliedMigrations(db) {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (!exists) return new Map();

  const rows = db.prepare(`SELECT version, name, checksum, applied_at, duration_ms FROM ${MIGRATIONS_TABLE}`).all();
  return new Map(rows.map((r) => [r.version, r]));
}

/** Migrations on disk that the ledger has never recorded. */
function pendingMigrations(db) {
  const applied = appliedMigrations(db);
  return listMigrations().filter((m) => !applied.has(m.version));
}

/**
 * Applies everything pending, oldest first.
 *
 * Each migration runs inside ONE transaction that also contains the insert into
 * `_migrations`. That is the whole safety argument: if the SQL half fails the
 * ledger half is rolled back with it, so a half-applied migration is impossible
 * and a retry re-runs it from the top. Nothing is ever marked done that did not
 * finish.
 *
 * Throws (loudly) if a migration fails. The caller decides what to do; the
 * server treats it as a boot failure rather than starting up on a schema it
 * does not understand.
 *
 * @returns {{applied: Array, alreadyApplied: number, warnings: string[]}}
 */
function runMigrations(db, options = {}) {
  const { logger = noopLogger, to = null, autoBackup = null } = options;

  if (running) {
    // Better than interleaving two runs on one file. Not a real risk in a
    // single-process server, but a silent corruption bug if it ever happens.
    return { applied: [], alreadyApplied: 0, warnings: ['migration run already in progress'] };
  }

  ensureMigrationsTable(db);
  const all = listMigrations();
  const appliedSoFar = appliedMigrations(db);
  const warnings = [];

  let pending = all.filter((m) => !appliedSoFar.has(m.version));
  if (to) {
    const stopAt = String(to).padStart(3, '0');
    pending = pending.filter((m) => m.version <= stopAt);
  }

  if (pending.length === 0) {
    return { applied: [], alreadyApplied: all.length, warnings };
  }

  // Warn when a migration's bytes changed after it shipped. We do NOT re-run
  // it: an already-applied migration is not safely replayable, and re-running
  // one is how databases get corrupted. Flagging it is the honest response.
  for (const m of all) {
    const row = appliedSoFar.get(m.version);
    if (row && row.checksum && row.checksum !== m.checksum) {
      const msg = `migration ${m.version}-${m.name} changed after it was applied (recorded ${row.checksum.slice(0, 12)}, on disk ${m.checksum.slice(0, 12)})`;
      warnings.push(msg);
      logger.warn(msg, { migration: m.version, kind: 'migration_modified_after_apply' });
    }
  }

  // An upgrade of a database that already holds data gets one free safety copy
  // before anything is rewritten. Cheap insurance; see docs/MIGRATION.md.
  const snapshotFn = autoBackup ?? defaultAutoBackup(db, all, appliedSoFar);
  if (snapshotFn) {
    try {
      const snapshot = snapshotFn();
      logger.warn('took a pre-migration snapshot of the database', snapshot);
    } catch (err) {
      // A failed snapshot must not stop the migration — but the operator has to
      // know the safety net was not armed.
      const msg = `pre-migration backup FAILED (${err.message}); continuing, but there is no rollback copy`;
      warnings.push(msg);
      logger.error(msg, { error: err.message, kind: 'pre_migration_backup_failed' });
    }
  }

  const applied = [];
  running = true;
  try {
    for (const m of pending) {
      const started = Date.now();
      let details;
      // The transaction wraps BOTH the migration and its ledger row. See above.
      const runOne = db.transaction(() => {
        details = m.up(db, { logger, version: m.version, name: m.name });
        db.prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at, duration_ms)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(m.version, m.name, m.checksum, new Date().toISOString(), Date.now() - started);
      });
      runOne();

      applied.push(m.version);
      const extra =
        details && typeof details === 'object' && Object.keys(details).length ? { details } : {};
      logger.info('migration applied', {
        migration: m.version,
        name: m.name,
        duration_ms: Date.now() - started,
        ...extra,
      });
    }
  } finally {
    running = false;
  }

  return { applied, alreadyApplied: all.length - pending.length, warnings };
}

/**
 * Returns a function that writes a snapshot, or null when no snapshot is due.
 *
 * A snapshot is due when this looks like an upgrade of a populated pre-runner
 * install rather than a brand new database — i.e. there are user tables, there
 * is nothing in the ledger yet, and there is at least one migration to run.
 * That is exactly the v0.0.2 -> v2 upgrade, which is the one where the old
 * behaviour was silently destructive.
 *
 * Env: `MIGRATION_AUTO_BACKUP=0` opts out, `PRE_MIGRATION_BACKUP_DIR`
 * overrides where it lands (default `<DATA_DIR>/pre-migration`).
 */
function defaultAutoBackup(db, all, applied) {
  if (process.env.MIGRATION_AUTO_BACKUP === '0') return null;

  const populated = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?")
    .all(MIGRATIONS_TABLE)
    .some((r) => r.name);
  if (!populated) return null;

  // Everything on disk already applied -> nothing to rewrite -> no snapshot.
  if (!all.some((m) => !applied.has(m.version))) return null;

  // SYNCHRONOUS on purpose. `runMigrations()` is synchronous (initDB() is), so an
  // async snapshot here would not be awaited: the schema rewrite would commit
  // first and the "pre-migration" copy would be taken afterwards, capturing the
  // already-migrated database. That is worse than no backup at all, because it
  // looks like a rollback path in the log and is not one. This was the bug; see
  // createBackupSync in ../ops/backup for the VACUUM INTO path it uses.
  return () => {
    // Lazy require: backup.js pulls in better-sqlite3 again and this path only
    // runs on an upgrade.
    // eslint-disable-next-line global-require
    const { createBackupSync } = require('../ops/backup');
    const path = require('path');

    const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
    const outDir =
      process.env.PRE_MIGRATION_BACKUP_DIR || path.join(dataDir, 'pre-migration');

    const manifest = createBackupSync({
      db,
      dbPath: db.name,
      outDir,
      retention: Number(process.env.PRE_MIGRATION_BACKUP_RETENTION || 3),
      includeUploads: false,
      label: 'pre-migration snapshot (automatic)',
    });
    return {
      kind: 'pre_migration_backup',
      path: manifest.path,
      bytes: manifest.bytes,
      sha256: manifest.sha256,
      counts: manifest.counts,
      note: 'restore from this directory to roll back; it is NOT a scheduled backup',
    };
  };
}

/**
 * Flat status for /healthz, the ops routes and `npm run migrate:status`.
 *
 * `ok` is the single thing health checks should branch on.
 */
function migrationStatus(db) {
  const all = listMigrations();
  const applied = appliedMigrations(db);
  const pending = all.filter((m) => !applied.has(m.version));

  return {
    ok: pending.length === 0,
    latest: all.length ? all[all.length - 1].version : null,
    count: all.length,
    applied_count: applied.size,
    pending: pending.map((m) => `${m.version}-${m.name}`),
    // Highest ledger entry, which is what a running process has actually got.
    current: applied.size
      ? [...applied.values()].sort((a, b) => (a.version < b.version ? 1 : -1))[0].version
      : null,
    applied: [...applied.values()].map((r) => ({
      version: r.version,
      name: r.name,
      applied_at: r.applied_at,
      duration_ms: r.duration_ms,
    })),
  };
}

module.exports = {
  MIGRATIONS_TABLE,
  listMigrations,
  appliedMigrations,
  pendingMigrations,
  runMigrations,
  migrationStatus,
  ensureMigrationsTable,
};
