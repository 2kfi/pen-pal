require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { initDB, getDb, resetDB, closeDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_SECRETS = ['change-this-secret', 'change-this-to-a-secure-random-secret'];

if (!JWT_SECRET || DEFAULT_SECRETS.includes(JWT_SECRET)) {
  const msg = 'JWT_SECRET must be set to a non-default value';
  if (isProd) {
    console.error(JSON.stringify({ t: new Date().toISOString(), level: 'fatal', msg }));
    process.exit(1);
  } else {
    console.warn(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg: `${msg} (dev fallback in use)` }));
  }
}
const SECRET = JWT_SECRET && !DEFAULT_SECRETS.includes(JWT_SECRET) ? JWT_SECRET : 'dev-only-insecure-secret';

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// Explicit CSP instead of helmet()'s default.
//
// Why not the default: it ships `upgrade-insecure-requests` (breaks plain-HTTP LAN
// deployments, which is the normal case for a self-hosted pen pal) and an img-src
// of `'self' data:`, which silently blocked every externally-hosted image.
//
// `style-src` allows 'unsafe-inline' because React inline style={{}} props are used
// pervasively. That is tracked tech debt — it goes away when styles move to the
// token/component layer. See docs/DESIGN.md.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  mediaSrc: ["'self'", 'blob:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    crossOriginEmbedderPolicy: false,
  }),
);
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : (isProd ? false : true);
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));

// Request IDs and crash handlers. Mounted before every route so a request id
// exists for anything logged afterwards, including 404s.
const { requestContext, errorHandler } = require('./lib/ops/request-context');
const { installProcessHandlers } = require('./lib/ops/logger');
installProcessHandlers();
app.use(requestContext());

// NOTE: v0.0.2 mounted `express.static('public')` here, which meant `/` served the
// legacy vanilla app while `/letters` served the React app — two apps, two auth
// flows, one origin. The legacy client is archived in git history and is no longer
// served. There is now exactly one app.

const uploadsDir = path.join(__dirname, '../uploads');
// 0700: these are plaintext photos and only the app's own process ever reads them.
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
// NOTE: the /uploads static mount is registered further down, *after* auth is
// defined. v0.0.2 served it world-readable at /uploads/<uuid>, which put every
// uploaded photo in plaintext on a public URL and contradicted the app's entire
// E2E promise.

// The upload pipeline lives in server/uploads.js (plan step 21). It sniffs the
// real magic bytes, caps decoded pixels, re-encodes through sharp (dropping
// EXIF/GPS/ICC profiles and anything appended to the file), generates a
// thumbnail, and only then writes to disk. Nothing here trusts
// `file.mimetype` — that value is the client's own Content-Type header.
const { photoUpload, processUpload, thumbUrlFor } = require('./uploads');

// Behind a reverse proxy every request arrives with the PROXY's address unless
// Express is told to trust the forwarding headers. Without this, express-rate-limit
// keys every request in the instance to a single IP: one person tripping the
// limit locks out their pen pal, and nobody can ever sign up again.
//
// Set TRUST_PROXY=1 when running behind Caddy/nginx (see docs/SELF-HOSTING.md).
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : 1);
}

// These limits are sized for a SELF-HOSTED instance where the user population
// is small and known, not for public multi-tenant SaaS. The v0.0.2 value of
// 30/15min was a SaaS default applied to an app whose entire premise is that
// there are a handful of people on it.
const AUTH_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000);
const SIGNUP_MAX = Number(process.env.SIGNUP_RATE_MAX || 120);
const LOGIN_MAX = Number(process.env.LOGIN_RATE_MAX || 60);
const WRITE_MAX = Number(process.env.WRITE_RATE_MAX || 300);

const common = { windowMs: AUTH_WINDOW_MS, standardHeaders: true, legacyHeaders: false };

/**
 * Keyed on the authenticated user id where there is one, so an entire household
 * behind a single NAT address does not throttle itself. Falls back to the
 * client IP for unauthenticated routes.
 */
const perUser = (limit) =>
  rateLimit({ ...common, limit, keyGenerator: (req) => req.user?.id ?? req.ip });


/**
 * A syntactically valid bcrypt hash of a value nobody can supply, used to spend the
 * same CPU on the "user does not exist" path as on a real verification. Without it
 * a missing account responds noticeably faster than a wrong password.
 */


// DB is synchronous (better-sqlite3); init once at boot.
initDB();

const { authenticateToken, checkStr, generatePID, DUMMY_HASH } = require('./lib/auth');

// ---------------------------------------------------------------------------
// Route modules. Mounted here rather than inline so each concern owns its file
// and can be tested in isolation.
//
// Order matters in two places:
//   - routers go BEFORE the SPA fallback, or client routes 404 into index.html
//   - the letters router must be mounted before anything else claims
//     /api/letters, because Express takes the first match
// ---------------------------------------------------------------------------
const authRoutes = require('./routes/auth');
const letterRoutes = require('./routes/letters');
const opsRoutes = require('./routes/ops');

app.use('/api', authRoutes());
app.use('/api/letters', letterRoutes());
app.use(opsRoutes());

app.get('/api/me', authenticateToken, (req, res) => {
  const user = getDb().prepare('SELECT id, username, friendly_name, email, pid, public_key as publicKey, encrypted_private_key as encryptedPrivateKey, age, birthday, favorite_food, bio, avatar_url, profile_data FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.put('/api/me', authenticateToken, (req, res) => {
  const { friendly_name, age, birthday, favorite_food, bio } = req.body || {};
  try {
    getDb().prepare(`UPDATE users SET friendly_name = COALESCE(?, friendly_name), age = COALESCE(?, age),
      birthday = COALESCE(?, birthday), favorite_food = COALESCE(?, favorite_food), bio = COALESCE(?, bio) WHERE id = ?`)
      .run(friendly_name ?? null, age ?? null, birthday ?? null, favorite_food ?? null, bio ?? null, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

/**
 * A pair is stored as one row per user, so checking one direction is sufficient —
 * both rows are always written together inside the same transaction-ish block.
 */
function isPaired(db, aId, bId) {
  return !!db.prepare('SELECT user_id FROM pairs WHERE user_id = ? AND partner_id = ?').get(aId, bId);
}

/** Returns the current partner row for a user, or undefined. */
function currentPair(db, userId) {
  return db.prepare('SELECT * FROM pairs WHERE user_id = ?').get(userId);
}

app.post('/api/pairing/request', authenticateToken, perUser(WRITE_MAX), (req, res) => {
  const { targetPid } = req.body || {};
  const bad = checkStr(targetPid, { required: true, min: 1, max: 16 });
  if (bad) return res.status(400).json({ error: `Invalid pairing body: ${bad}` });
  if (targetPid === req.user.pid) return res.status(400).json({ error: 'Cannot pair with yourself' });
  try {
    const db = getDb();
    const target = db.prepare('SELECT id FROM users WHERE pid = ?').get(targetPid);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const existing = db.prepare('SELECT id FROM pairings WHERE requester_id = ? AND target_pid = ? AND status = ?').get(req.user.id, targetPid, 'pending');
    if (existing) return res.status(400).json({ error: 'Request already sent' });

    db.prepare('INSERT INTO pairings (requester_id, target_pid) VALUES (?, ?)').run(req.user.id, targetPid);
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(target.id, 'pairing_request', 'New Pairing Request', `${req.user.username} wants to pair with you!`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not send pairing request' });
  }
});

app.get('/api/pairing/status', authenticateToken, (req, res) => {
  const db = getDb();
  const incoming = db.prepare(`SELECT p.id, u.username, u.friendly_name, u.pid FROM pairings p JOIN users u ON p.requester_id = u.id WHERE p.target_pid = ? AND p.status = 'pending'`).all(req.user.pid);
  const outgoing = db.prepare('SELECT id, target_pid, status FROM pairings WHERE requester_id = ?').all(req.user.id);
  const currentPairRow = currentPair(db, req.user.id);

  let partner = null;
  if (currentPairRow) {
    partner =
      db
        .prepare('SELECT id, username, friendly_name, pid, public_key as publicKey, avatar_url FROM users WHERE id = ?')
        .get(currentPairRow.partner_id) ?? null;
  }

  res.json({ incoming, outgoing, partner });
});

app.post('/api/pairing/accept', authenticateToken, (req, res) => {
  const { requestId } = req.body || {};
  if (requestId === undefined || requestId === null) return res.status(400).json({ error: 'requestId is required' });
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
    if (!request || request.target_pid !== req.user.pid) return res.status(403).json({ error: 'Invalid request' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This invite was already handled' });

    const target = db.prepare('SELECT id FROM users WHERE pid = ?').get(request.target_pid);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // One partner, at a time. The question is "is EITHER party already paired with
    // anyone", not "are these two already paired" — checking the latter lets a
    // paired user accept a second partner and then hit the pairs PRIMARY KEY.
    // v0.0.2 checked nothing, so a user could accumulate unlimited pairs and
    // `SELECT * FROM pairs WHERE user1_id = ? OR user2_id = ?` with .get()
    // returned an ARBITRARY one — meaning Compose could silently post a letter to
    // whichever partner the query happened to surface first.
    const alreadyPaired = db
      .prepare('SELECT user_id FROM pairs WHERE user_id IN (?, ?) LIMIT 1')
      .get(request.requester_id, target.id);

    if (alreadyPaired) {
      db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('superseded', requestId);
      return res.status(409).json({
        error: 'One of you is already paired. Unpair before accepting someone new.',
      });
    }

    db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('accepted', requestId);
    // Two rows, one per user. user_id is the PRIMARY KEY, so a second pairing for
    // either party fails loudly here instead of silently accumulating.
    const insertPair = db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)');
    insertPair.run(request.requester_id, target.id);
    insertPair.run(target.id, request.requester_id);
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)')
      .run(request.requester_id, 'pairing_accepted', 'Pairing accepted', `${req.user.username} accepted your pairing request!`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not accept pairing' });
  }
});

app.post('/api/pairing/reject', authenticateToken, (req, res) => {
  const { requestId } = req.body || {};
  if (requestId === undefined || requestId === null) return res.status(400).json({ error: 'requestId is required' });
  try {
    const db = getDb();
    const request = db.prepare('SELECT * FROM pairings WHERE id = ?').get(requestId);
    if (!request || request.target_pid !== req.user.pid) return res.status(403).json({ error: 'Invalid request' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });

    db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run('rejected', requestId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not reject pairing' });
  }
});

app.delete('/api/pairs/unpair', authenticateToken, (req, res) => {
  try {
    // Both rows are removed together so the two sides can never disagree.
    getDb().prepare('DELETE FROM pairs WHERE user_id = ? OR partner_id = ?').run(req.user.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not unpair' });
  }
});

function pageParams(req) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const cursor = req.query.cursor !== undefined ? parseInt(req.query.cursor, 10) : null;
  return { limit, cursor: Number.isInteger(cursor) ? cursor : null };
}

/**
 * Letters are paginated by a monotonic id cursor, oldest first.
 *
 * Delivery gating: a letter with a future `delivered_at` is visible ONLY to its
 * sender, who should see it sitting in transit. The recipient sees nothing until
 * it arrives. v0.0.2 stored `delivered_at` and never filtered on it, so the
 * "Deliver no earlier than" date was decorative — scheduled mail arrived at once.
 */
// Everything about this route is delegated to the pipeline in server/uploads.js.
// The response shape is unchanged (`id`, `url`) plus `thumbUrl`, so the existing
// client keeps working.
app.post('/api/photos/upload', authenticateToken, perUser(WRITE_MAX), (req, res) => {
  photoUpload.single('photo')(req, res, async (err) => {
    if (err || !req.file) {
      const status = err instanceof multer.MulterError ? 400 : err?.status || 400;
      return res.status(status).json({ error: err ? err.message : 'No file uploaded' });
    }
    try {
      const stored = await processUpload(req.file.buffer, uploadsDir);
      const info = getDb().prepare('INSERT INTO photos (user_id, filename, filepath) VALUES (?, ?, ?)')
        .run(req.user.id, stored.filename, stored.filepath);
      res.json({
        id: info.lastInsertRowid,
        url: stored.filepath,
        thumbUrl: stored.thumbFilepath || thumbUrlFor(stored.filepath),
      });
    } catch (e) {
      // Fail closed: a rejected upload never reached the disk, so there is
      // nothing to clean up here.
      if (e && e.name === 'UploadRejected') {
        return res.status(e.status || 400).json({ error: e.message });
      }
      log('Photo upload failed', { error: e && e.message });
      res.status(500).json({ error: 'Upload failed' });
    }
  });
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const { limit, cursor } = pageParams(req);
  const db = getDb();
  const notifications = cursor === null
    ? db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit)
    : db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(req.user.id, cursor, limit);
  res.json(notifications);
});

app.put('/api/notifications/read', authenticateToken, (req, res) => {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

// Jellyfin integration removed (V2 plan step 8). Browsing a shared media server is
// not correspondence — it was a different product bolted onto this one, and it
// dragged in an unauthenticated image origin that fought our CSP.
// Encrypted keepsakes attached to letters replace it.

// Uploads are served only to an authenticated request.
// v0.0.2 mounted this world-readable at /uploads/<uuid>, which put every photo in
// plaintext on a public URL and quietly contradicted the E2E promise.
app.use(
  '/uploads',
  authenticateToken,
  express.static(uploadsDir, {
    // Nothing served from here is user-controlled HTML, and the pipeline
    // guarantees raster-only output. nosniff plus an explicit index denial keeps
    // the mount a plain file server.
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }),
);

// DB Reset: disabled in production; otherwise requires ADMIN_TOKEN. Never logged.
app.post('/api/admin/reset-db', authenticateToken, (req, res) => {
  if (isProd) return res.status(404).json({ error: 'Not found' });
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(403).json({ error: 'Admin reset disabled' });
  const got = req.headers['x-admin-token'] || req.body?.adminToken || req.body?.code;
  if (got !== expected) return res.status(403).json({ error: 'Invalid admin token' });

  try {
    resetDB();
    log('Database has been reset');
    res.json({ success: true, message: 'Database reset successfully' });
  } catch (err) {
    log('DB reset failed', { error: err.message });
    res.status(500).json({ error: 'Failed to reset database' });
  }
});

// Multer/fileFilter errors -> 400 JSON (must be after routes)
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|uploads|healthz).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}
 // eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err) {
    const status = err instanceof multer.MulterError || /Only image/.test(err.message || '') ? 400 : 500;
    return res.status(status).json({ error: err.message || 'Upload failed' });
  }
  next();
});

// The terminal error handler MUST come last: after every route AND after the
// SPA fallback, or a thrown error in a route falls through to index.html and
// comes back to the client as a 200 full of HTML.
app.use(errorHandler());

let server;
function startServer() {
  log('Database initialized', { wal: true });
  server = app.listen(PORT, () => {
    log('PenPal Archive running', { port: PORT });
  });
  return server;
}

function shutdown(signal) {
  log('Shutting down', { signal });

  // Close SSE streams BEFORE closing the DB. Each stream owns a sweep interval
  // and a live socket; leaving them up means process.exit() is the only thing
  // that can end them, and in tests that hangs the runner rather than failing it.
  const bus = letterRoutes.createBus?.();
  if (bus) {
    try {
      letterRoutes.closeAllStreams?.();
    } catch (err) {
      log('error closing letter streams', { error: err.message });
    }
  }

  if (server) {
    server.close(() => {
      closeDB();
      process.exit(0);
    });
    // Backstop: server.close() waits for open sockets, and an SSE connection
    // never goes idle on its own.
    setTimeout(() => process.exit(0), 5000).unref();
  } else {
    closeDB();
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, shutdown };
