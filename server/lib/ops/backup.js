/**
 * Backups.
 *
 * ## Why this does not use `cp`
 *
 * The database runs in WAL mode. In WAL mode recent writes live in `penpal.db-wal`
 * and are only folded back into the main file at a checkpoint. `cp penpal.db`
 * while the server is up therefore copies a file that is missing its own tail —
 * a database whose last few letters do not exist. It is not "slightly stale", it
 * is corrupt-or-truncated depending on timing, and whether you can tell the
 * difference is luck.
 *
 * SQLite's online backup API is the correct tool: it takes a read lock per page
 * and produces a single self-consistent file that includes the WAL. This module
 * calls it through better-sqlite3's `db.backup()`, which is a thin wrapper over
 * `sqlite3_backup_init/step/finish` — the same machinery as the `sqlite3`
 * command line's `.backup`, so `scripts/backup.sh` and the CLI produce
 * equivalent files.
 *
 * ## What is NOT in here
 *
 * No encryption. A backup file is a copy of the live database: ciphertext for
 * letter bodies, but plaintext for uploaded photos and for account metadata. See
 * docs/SECURITY.md before you start shipping these off the machine.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { logger } = require('./logger');

/** `2026-10-13T14-03-11-482Z` — sortable, and legal in a path on every OS. */
function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
}

const DEFAULT_RETENTION = Number(process.env.BACKUP_RETENTION || 14);

/** Tables worth counting. Missing ones are reported, not treated as corruption. */
const COUNT_TABLES = ['users', 'pairs', 'letters', 'pairings', 'notifications', 'photos', '_migrations'];

function sha256(file, chunkSize = 1 << 20) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let bytes;
    // eslint-disable-next-line no-cond-assign
    while ((bytes = fs.readSync(fd, buf, 0, chunkSize, null)) > 0) hash.update(buf.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Opens a file read-only and reports whether it is a usable database. */
function inspectDatabase(file) {
  const result = { ok: false, file, integrity: null, counts: {}, journal_mode: null, error: null };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    result.integrity = db.pragma('integrity_check', { simple: true });
    if (result.integrity !== 'ok') {
      result.error = `integrity_check said: ${result.integrity}`;
      return result;
    }
    result.journal_mode = db.pragma('journal_mode', { simple: true });
    for (const table of COUNT_TABLES) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      if (!exists) continue;
      result.counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    }
    // The shape check that actually matters for a restore: a restored v0.0.2
    // file would still have `pairs(user1_id, user2_id)` and the app would 500 on
    // every pairing query.
    const pairCols = db.pragma('table_info(pairs)').map((c) => c.name);
    result.pairs_shape = pairCols.includes('user_id') && pairCols.includes('partner_id')
      ? 'current'
      : pairCols.includes('user1_id')
        ? 'v0.0.2'
        : 'unknown';
    result.ok = true;
    return result;
  } catch (err) {
    result.error = err.message;
    return result;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
  }
}

function sha256OfManifestTarget(dbFile) {
  return sha256(dbFile);
}

/**
 * Synchronous snapshot via `VACUUM INTO`.
 *
 * Same family of operation as the online backup API — a read transaction that
 * copies a consistent set of pages, WAL contents included — but it returns when
 * it is done instead of handing back a promise. That matters in exactly one
 * place: the migration runner has to finish writing its safety copy BEFORE it
 * starts rewriting the schema, and `runMigrations()` is synchronous because
 * `initDB()` is.
 *
 * `VACUUM INTO` refuses to overwrite an existing file, which is a feature here:
 * the target path is generated per run.
 */
function vacuumInto(db, target) {
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite an existing file: ${target}`);
  // The path is interpolated rather than bound because VACUUM INTO takes a
  // string literal. Single quotes are doubled; nothing else can produce a
  // quote in this path because it is built by us.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

async function writeBackupDir({ db, dbPath, outDir, retention, includeUploads, uploadsDir, label, version, log }) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  // The directory name is the id. Two backups in the same second would collide;
  // add a counter suffix rather than overwriting the first one.
  let name = `penpal-${timestamp()}`;
  let dir = path.join(outDir, name);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(outDir, `${name}-${n++}`);
    name = path.basename(dir);
  }
  fs.mkdirSync(dir, { mode: 0o700 });

  const target = path.join(dir, 'penpal.db');
  let ownHandle = false;

  try {
    if (!db) {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      ownHandle = true;
    }

    // The online backup. Resolves when the destination is complete.
    await db.backup(target);

    const inspection = inspectDatabase(target);
    if (!inspection.ok) {
      throw new Error(`backup verification failed: ${inspection.error}`);
    }

    const dbStat = fs.statSync(target);
    const manifest = {
      created_at: new Date().toISOString(),
      directory: name,
      path: dir,
      source: dbPath,
      method: 'sqlite online backup (sqlite3_backup)',
      bytes: dbStat.size,
      sha256: sha256OfManifestTarget(target),
      integrity: inspection.integrity,
      counts: inspection.counts,
      pairs_shape: inspection.pairs_shape,
      app_version: version,
      label,
      uploads: null,
    };

    if (includeUploads && fs.existsSync(uploadsDir)) {
      // Photos are plaintext, so this is the part of a backup that actually
      // needs protecting in transit. Copy, do not symlink.
      const dest = path.join(dir, 'uploads');
      fs.cpSync(uploadsDir, dest, { recursive: true, dereference: false });
      manifest.uploads = {
        path: 'uploads',
        files: fs.readdirSync(dest, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length,
      };
    }

    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    log.info('backup written', { path: dir, bytes: manifest.bytes, counts: manifest.counts });

    return manifest;
  } finally {
    if (ownHandle && db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Writes one backup into `<outDir>/penpal-<timestamp>/`.
 *
 * @param {object}   opts
 * @param {import('better-sqlite3').Database} [opts.db]  open handle; opened read-only from dbPath if absent
 * @param {string}   opts.dbPath
 * @param {string}   [opts.outDir='./backups']
 * @param {number}   [opts.retention=14]  directories to keep; 0 keeps everything
 * @param {boolean}  [opts.includeUploads=true]
 * @param {string}   [opts.uploadsDir]
 * @param {string}   [opts.label]         free text recorded in the manifest
 * @returns {Promise<object>} manifest
 */
async function createBackup(opts = {}) {
  const {
    dbPath,
    outDir = path.join(process.cwd(), 'backups'),
    retention = DEFAULT_RETENTION,
    includeUploads = true,
    uploadsDir = path.join(process.cwd(), 'uploads'),
    label = null,
    version = null,
    log = logger,
  } = opts;

  if (!dbPath) throw new Error('createBackup requires a dbPath');

  const manifest = await writeBackupDir({
    db: opts.db,
    dbPath,
    outDir,
    includeUploads,
    uploadsDir,
    label,
    version,
    log,
  });
  manifest.duration_ms = undefined;
  manifest.pruned = pruneBackups(outDir, retention, { log });
  return manifest;
}

/**
 * The same thing, synchronously, via `VACUUM INTO`. See above for why two
 * code paths exist. No uploads, no pruning: this is a safety net taken seconds
 * before a schema rewrite, not a scheduled backup.
 */
function createBackupSync(opts = {}) {
  const {
    db,
    dbPath,
    outDir,
    includeUploads = false,
    uploadsDir,
    label = null,
    version = null,
    retention = 3,
    log = logger,
  } = opts;

  if (!db) throw new Error('createBackupSync requires an open db handle');
  if (!outDir) throw new Error('createBackupSync requires an outDir');

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  let name = `penpal-${timestamp()}`;
  let dir = path.join(outDir, name);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(outDir, `${name}-${n++}`);
    name = path.basename(dir);
  }
  fs.mkdirSync(dir, { mode: 0o700 });

  const target = path.join(dir, 'penpal.db');
  vacuumInto(db, target);

  const inspection = inspectDatabase(target);
  if (!inspection.ok) {
    throw new Error(`pre-migration snapshot verification failed: ${inspection.error}`);
  }

  const manifest = {
    created_at: new Date().toISOString(),
    directory: name,
    path: dir,
    source: dbPath || db.name,
    method: 'VACUUM INTO',
    bytes: fs.statSync(target).size,
    sha256: sha256(target),
    integrity: inspection.integrity,
    counts: inspection.counts,
    pairs_shape: inspection.pairs_shape,
    app_version: version,
    label,
    uploads: null,
  };

  if (includeUploads && uploadsDir && fs.existsSync(uploadsDir)) {
    fs.cpSync(uploadsDir, path.join(dir, 'uploads'), { recursive: true, dereference: false });
    manifest.uploads = { path: 'uploads' };
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  manifest.pruned = pruneBackups(outDir, retention, { log });
  return manifest;
}

/** Backup directory names, oldest first. */
function listBackups(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('penpal-'))
    .map((e) => e.name)
    .sort();
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Deletes the oldest backup directories past the retention window.
 * `retention <= 0` keeps everything.
 */
function pruneBackups(outDir, retention = DEFAULT_RETENTION, { log = logger, dryRun = false } = {}) {
  const all = listBackups(outDir);
  if (retention <= 0 || all.length <= retention) return [];

  const doomed = all.slice(0, all.length - retention);
  const removed = [];
  for (const name of doomed) {
    const dir = path.join(outDir, name);
    if (dryRun) {
      removed.push(dir);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
      log.info('pruned old backup', { path: dir });
    } catch (err) {
      log.error('could not prune backup', { path: dir, error: err.message });
    }
  }
  return removed;
}

/**
 * Verifies a backup without restoring it: opens it, runs integrity_check, counts
 * rows, and confirms the `pairs` table is the shape the current code expects.
 *
 * A backup that passes integrity_check but holds a v0.0.2 `pairs` table is still
 * a good backup — it is just a backup of an older app, and restoring it will put
 * you back on that older app. Worth saying out loud.
 */
function verifyBackup(dir) {
  const file = path.join(dir, 'penpal.db');
  const result = inspectDatabase(file);
  const manifest = readManifest(dir);

  // Checked INDEPENDENTLY of `result.ok`. These are two different questions and
  // the operator needs both answered at once: "is this a working database?"
  // (integrity_check) and "is this the file I took?" (checksum). Gating the
  // checksum on a successful integrity_check meant a corrupted backup reported
  // `ok:false` with no checksum verdict at all, which reads as "we didn't
  // check" rather than "it is wrong".
  if (manifest?.sha256) {
    try {
      result.sha256_matches_manifest = sha256(file) === manifest.sha256;
    } catch (err) {
      result.sha256_matches_manifest = false;
      result.sha256_error = err.message;
    }
  }

  result.manifest = manifest;
  result.uploads_present = fs.existsSync(path.join(dir, 'uploads'));
  return result;
}

module.exports = {
  createBackup,
  // Used by the migration runner, which cannot await. See the doc comment.
  createBackupSync,
  listBackups,
  pruneBackups,
  verifyBackup,
  inspectDatabase,
  readManifest,
  timestamp,
  sha256,
  DEFAULT_RETENTION,
};
