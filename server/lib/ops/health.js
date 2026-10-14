/**
 * A `/healthz` that means something.
 *
 * The v0.0.2 version was `res.json({ ok: true })` inside the process, which is a
 * liveness probe wearing a readiness check's name. It answered "is this Node
 * process scheduled?" while the orchestrator, the deploy workflow and the user
 * all read it as "can this instance serve requests?".
 *
 * It was green through every failure that actually mattered:
 *   - the database file was deleted out from under a running process
 *   - a migration had failed and the schema no longer matched the code
 *   - the disk was full and every write was throwing
 *
 * So this one checks the things a request needs:
 *
 *   - the database is reachable AND writable (not just open)
 *   - no migration is pending, i.e. the code and the schema agree
 *   - the process has been up long enough to have finished booting
 *
 * The response keeps `ok` as the top-level boolean and still answers 200 when
 * healthy, because docker-compose's healthcheck, the CI wait loop and the deploy
 * rollback all branch on exactly that. Everything else is additive.
 *
 * `GET /healthz` is unauthenticated by design — a load balancer has to be able
 * to call it. It therefore reveals only whether the instance is usable, never
 * what version it is or who is in it. `/api/ops/status` is the admin-gated one
 * with the detail.
 */

const fs = require('fs');
const { migrationStatus } = require('../migrations');

const BOOT_GRACE_MS = Number(process.env.HEALTHZ_BOOT_GRACE_MS || 5000);

/**
 * Integrity checking on every probe is O(database). Fine for a two-account
 * letter app; turn it off if you ever point this at something big.
 */
const DEEP_CHECK = process.env.HEALTHZ_DEEP !== '0';

/**
 * Off by default: it writes to the database on every probe. Turn it on
 * (`HEALTHZ_WRITE_CHECK=1`) if you would rather find out about a full disk from
 * the health check than from a failed letter.
 */
const WRITE_CHECK = process.env.HEALTHZ_WRITE_CHECK === '1';

function checkDatabase(db, dbPath) {
  const started = Date.now();

  // Order matters. The failure this catches first is the file vanishing from
  // under a live process: better-sqlite3 holds an open fd, so `SELECT 1` keeps
  // happily succeeding against an unlinked inode and the instance looks perfect
  // right up until it restarts onto an empty directory.
  if (dbPath) {
    if (!fs.existsSync(dbPath)) {
      return { ok: false, error: `database file is missing: ${dbPath}`, latency_ms: Date.now() - started };
    }
    try {
      fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      return { ok: false, error: `database file is not readable and writable: ${err.code || err.message}`, latency_ms: Date.now() - started };
    }
  }

  try {
    if (!db) return { ok: false, error: 'database handle is not open' };

    db.prepare('SELECT 1 AS ok').get();

    if (DEEP_CHECK) {
      // Catches a corrupted file, which every other check here sails straight
      // past because SQLite happily reads the pages it can.
      const quick = db.pragma('quick_check', { simple: true });
      if (quick !== 'ok') {
        return { ok: false, error: `integrity check failed: ${quick}`, latency_ms: Date.now() - started };
      }
    }

    if (WRITE_CHECK) {
      // The only way to find out the disk is full before somebody tries to send
      // a letter. Off by default because it writes on every probe; the table it
      // uses is dropped again so it never shows up in a schema audit.
      db.exec('CREATE TABLE IF NOT EXISTS _healthz (id INTEGER PRIMARY KEY)');
      try {
        db.prepare('INSERT INTO _healthz DEFAULT VALUES').run();
      } finally {
        db.exec('DROP TABLE IF EXISTS _healthz');
      }
    }

    return { ok: true, latency_ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.message, latency_ms: Date.now() - started };
  }
}

function checkMigrations(db) {
  try {
    const status = migrationStatus(db);
    return {
      ok: status.ok,
      applied: status.applied_count,
      known: status.count,
      pending: status.pending,
      current: status.current,
      latest: status.latest,
      ...(status.ok ? {} : { error: `pending migrations: ${status.pending.join(', ')}` }),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkUptime(startedAt) {
  const uptimeMs = Date.now() - startedAt;
  return { ok: uptimeMs >= BOOT_GRACE_MS, uptime_s: Math.round(uptimeMs / 1000) };
}

/**
 * @returns {{ok: boolean, status: string, statusCode: number, body: object}}
 */
function healthReport({ db = null, dbPath = null, startedAt = Date.now(), version = null } = {}) {
  const uptime = checkUptime(startedAt);
  const database = checkDatabase(db, dbPath);
  const migrations = checkMigrations(db);

  const checks = { uptime, database, migrations };
  // A pending migration is not "the process is starting", it is "the code on
  // disk does not match the schema on disk". Serving traffic into that is how a
  // bad deploy becomes a bad afternoon.
  const critical = [uptime, database, migrations];
  const ok = critical.every((c) => c.ok);

  const body = {
    // Kept: everything that branched on this before still branches correctly.
    ok,
    status: ok ? 'ok' : 'unhealthy',
    time: new Date().toISOString(),
    uptime_s: uptime.uptime_s,
    ...(version ? { version } : {}),
    checks,
  };

  return { ok, body, statusCode: ok ? 200 : 503 };
}

module.exports = { healthReport, checkDatabase, checkMigrations, BOOT_GRACE_MS };
