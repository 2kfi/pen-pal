const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { runMigrations, migrationStatus, listMigrations } = require('./lib/migrations');
const { logger } = require('./lib/ops/logger');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'penpal.db');

let db;

// Tables owned by the schema. `resetDB()` drops exactly these and lets the
// migration runner rebuild them, so there is one definition of the schema
// (server/lib/migrations/) rather than two that can drift.
const SCHEMA_TABLES = ['users', 'pairs', 'letters', 'pairings', 'notifications', 'photos', '_migrations'];

/**
 * Opens the database file, or explains why it cannot.
 *
 * The previous version of this function caught any failure to open and DELETED
 * the file before recreating it:
 *
 *     } catch (err) {
 *       fs.rmSync(dbPath, { force: true });   // <- the entire correspondence
 *       fs.rmSync(`${dbPath}-wal`, { force: true });
 *       fs.rmSync(`${dbPath}-shm`, { force: true });
 *       db = new Database(dbPath);
 *     }
 *
 * Every reason to fail that code handles — a corrupt file, a directory that
 * cannot be written — is a reason to RESTORE A BACKUP, not to start empty. The
 * catch converted "your disk is full" into "your letters are gone and the app
 * cheerfully came back up", and the health check said `ok: true` while it
 * happened. So: no silent deletion. The only case we paper over is a zero-byte
 * file, which cannot contain anything.
 */
function openDatabase(file) {
  try {
    return new Database(file);
  } catch (err) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size === 0) {
      // Nothing to lose: SQLite treats an empty file as a fresh database.
      return new Database(file);
    }
    const hint =
      'Refusing to start. The database file exists but could not be opened, and this ' +
      'server will not delete it to work around that — a file that will not open is ' +
      'usually a restore situation, not a delete situation. See docs/MIGRATION.md.';
    const wrapped = new Error(`${hint}\n  file: ${file}\n  cause: ${err.message}`);
    wrapped.cause = err;
    wrapped.code = 'DB_OPEN_FAILED';
    throw wrapped;
  }
}

function initDB() {
  if (db) return db;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Legacy sql.js files are plain SQLite files, so better-sqlite3 opens them
  // directly — opening the existing data/penpal.db IS most of the migration.
  db = openDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  // Wait rather than throw SQLITE_BUSY when another process (a backup script, a
  // second worker, an admin psql session) holds the write lock. Without this a
  // migration that arrives while cron is running takes the server down.
  db.pragma('busy_timeout = 5000');
  // Off by default in SQLite and cheap here: no foreign keys are declared
  // anywhere in the schema, and turning it on would reject the deliberate
  // dangling references that 020 preserves on purpose.
  db.pragma('foreign_keys = OFF');

  // Everything else — every table, every reshape, in order, once each — happens
  // here. See server/lib/migrations/.
  //
  // The logger is passed explicitly because without it the runner falls back to
  // a no-op and emits NOTHING: no "migration applied" line, no pre-migration
  // snapshot record, and — worst — no warning about pairings that were dropped
  // or accounts left pointing at a user that no longer exists. Those warnings
  // are the only way an operator finds out a letter is about to go missing.
  // docs/MIGRATION.md tells people to grep the logs for exactly this.
  runMigrations(db, { logger });

  // Return the handle. initDB() assigned `db` but returned undefined, so any
  // caller that reached a repository through a DIFFERENT module instance — a
  // route module importing db.js itself rather than going through index.js —
  // got undefined back and blew up at the first `.prepare(...)`. It presented
  // as "Cannot read properties of undefined (reading 'exec')" inside whichever
  // migration happened to touch the handle first.
  return db;
}

function getDb() {
  if (!db) return initDB();
  return db;
}

/**
 * Drops every table and replays the migrations from empty.
 *
 * Development affordance only. `/api/admin/reset-db` refuses to run in
 * production. This is a destructive operation and nothing here is trying to be
 * clever about that.
 */
function resetDB() {
  const handle = getDb();
  for (const table of SCHEMA_TABLES) {
    handle.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  runMigrations(handle, { logger });
}

function closeDB() {
  if (db) {
    try {
      db.close();
    } catch {
      // ponytail: ignore double-close
    }
    db = null;
  }
}

/** Absolute path of the database file. Health checks and ops routes need it. */
function getDbPath() {
  return dbPath;
}

function getDataDir() {
  return dataDir;
}

module.exports = {
  initDB,
  getDb,
  resetDB,
  closeDB,
  getDbPath,
  getDataDir,
  // Re-exported so `scripts/migrate.js` and the ops routes can share one import.
  runMigrations,
  migrationStatus,
  listMigrations,
};
