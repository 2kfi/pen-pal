/**
 * Operational routes: health, migrations, backups.
 *
 * A route module factory, like every other route module in this app:
 *
 *   const opsRoutes = require('./routes/ops');
 *   app.use(opsRoutes());
 *
 * Mount it with the router's own prefix decisions in mind:
 *
 *   app.use(opsRoutes());                 // routes land at /healthz, /api/ops/*
 *   app.use('/api', opsRoutes());         // routes land at /api/healthz
 *
 * `/healthz` lives in here rather than inline in index.js because a meaningful
 * health check needs the database handle and the migration ledger. See
 * server/lib/ops/health.js for what it actually checks.
 *
 * Admin routes require `ADMIN_TOKEN`. If that is not set they are CLOSED — not
 * open. An ops endpoint that quietly allows everything because somebody forgot
 * an env var is worse than no endpoint, because `POST /api/ops/backup` writes to
 * disk and `POST /api/ops/migrations` rewrites the schema.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { getDb, getDbPath } = require('../db');
const { runMigrations, migrationStatus } = require('../lib/migrations');
const { logger, healthReport } = require('../lib/ops');
const { createBackup, listBackups, verifyBackup, readManifest } = require('../lib/ops/backup');

const APP_VERSION = (() => {
  try {
    return require(path.join(__dirname, '../../package.json')).version;
  } catch {
    return null;
  }
})();

// Process start, not module load: the boot grace period in the health check is
// supposed to cover the whole boot, including loading the modules.
const startedAt = Date.now() - Math.round(process.uptime() * 1000);

/** Constant-time compare that does not leak length via an early return. */
function tokenMatches(expected, got) {
  if (typeof got !== 'string' || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) {
    // Still hash both so the timing does not depend on the length mismatch.
    crypto.createHash('sha256').update(b).digest();
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Gate for the mutating / detail-revealing routes.
 *
 * Token comes from `X-Admin-Token` or `Authorization: Bearer`. Never from a
 * query string — query strings land in access logs and in proxy logs.
 */
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    logger.error('admin ops route called but ADMIN_TOKEN is not set; refusing', {
      kind: 'admin_token_unset',
      path: req.path,
    });
    return res.status(403).json({ error: 'Admin ops disabled: ADMIN_TOKEN is not set' });
  }

  const header = req.headers['x-admin-token'];
  const bearer = (req.headers.authorization || '').split(' ')[1];
  const got = header || bearer;

  if (!tokenMatches(expected, got)) {
    logger.warn('admin ops auth failed', { kind: 'admin_auth_failed', path: req.path, ip: req.ip });
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  return next();
}

function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '../../data');
}

function uploadsDir() {
  return process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');
}

function backupDir() {
  return process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
}

/**
 * @returns {import('express').Router}
 */
module.exports = function opsRoutes() {
  const router = express.Router();

  /**
   * GET /healthz
   *
   * Backwards compatible: 200 with `{ ok: true, ... }` when healthy, so the
   * compose healthcheck, the CI wait loop and the deploy rollback all keep
   * working unchanged. 503 when the database is unreachable, unreadable, corrupt,
   * or a migration is still pending.
   *
   * Unauthenticated on purpose — a load balancer has to be able to call it. It
   * therefore reports usability, not inventory. In particular it does NOT
   * include the version number: an anonymous endpoint that names the exact
   * build is a free gift to anyone matching it against published advisories.
   * The version is in `/api/ops/status`, which requires ADMIN_TOKEN.
   */
  router.get('/healthz', (req, res) => {
    const report = healthReport({
      db: getDb(),
      dbPath: getDbPath(),
      startedAt,
      // No version — see above.
    });
    res.status(report.statusCode).json(report.body);
  });

  /** Alias, so a reverse proxy can expose the same thing under /api. */
  router.get('/api/healthz', (req, res) => {
    const report = healthReport({ db: getDb(), dbPath: getDbPath(), startedAt });
    res.status(report.statusCode).json(report.body);
  });

  /** Everything /healthz shows plus what an operator actually wants to see. */
  router.get('/api/ops/status', requireAdmin, (req, res) => {
    const report = healthReport({ db: getDb(), dbPath: getDbPath(), startedAt, version: APP_VERSION });
    res.status(report.statusCode).json({
      ...report.body,
      migrations: migrationStatus(getDb()),
      paths: { data: dataDir(), uploads: uploadsDir(), backups: backupDir() },
      node: process.version,
      pid: process.pid,
      memory_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    });
  });

  /** Which migrations exist, which have run, and which are waiting. */
  router.get('/api/ops/migrations', requireAdmin, (req, res) => {
    res.json(migrationStatus(getDb()));
  });

  /**
   * POST /api/ops/migrations
   *
   * Runs anything pending. The server already does this on boot, so this exists
   * for the case where a migration was added while the process was running and
   * you want it applied without a restart — and, more usefully, for seeing the
   * runner's judgement calls (dropped pairings, preserved legacy tables) again.
   */
  router.post('/api/ops/migrations', requireAdmin, (req, res) => {
    try {
      const result = runMigrations(getDb(), { logger });
      res.json({ ...result, status: migrationStatus(getDb()) });
    } catch (err) {
      logger.error('migration run failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message, requestId: req.requestId });
    }
  });

  /** Take a backup on demand, right now, through the same code path as cron. */
  router.post('/api/ops/backup', requireAdmin, async (req, res) => {
    try {
      const manifest = await createBackup({
        db: getDb(),
        dbPath: getDbPath(),
        outDir: backupDir(),
        includeUploads: req.body?.includeUploads !== false,
        uploadsDir: uploadsDir(),
        label: req.body?.label || `api:${req.requestId || 'manual'}`,
        version: APP_VERSION,
      });
      res.json({ backup: manifest });
    } catch (err) {
      logger.error('backup failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: err.message, requestId: req.requestId });
    }
  });

  router.get('/api/ops/backups', requireAdmin, (req, res) => {
    const dir = backupDir();
    const backups = listBackups(dir).map((name) => readManifest(path.join(dir, name))).filter(Boolean);
    res.json({ dir, count: backups.length, backups: backups.reverse() });
  });

  /**
   * GET /api/ops/backups/:name/verify
   *
   * Read-only. Proves the file is a working database with a sane `pairs` shape
   * before anybody finds out during an actual restore.
   */
  router.get('/api/ops/backups/:name/verify', requireAdmin, (req, res) => {
    const name = path.basename(String(req.params.name || ''));
    const dir = path.join(backupDir(), name);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No such backup' });

    const result = verifyBackup(dir);
    return res.status(result.ok ? 200 : 422).json(result);
  });

  return router;
};

module.exports.requireAdmin = requireAdmin;
module.exports.tokenMatches = tokenMatches;
module.exports.startedAtRef = startedAt;
