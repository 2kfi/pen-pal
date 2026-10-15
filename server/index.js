require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { initDB, closeDB } = require('./db');

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
// The mount that serves these files is registered near the other routers, after
// auth is defined. v0.0.2 served them world-readable at /uploads/<uuid>, which
// put every uploaded photo in plaintext on a public URL and contradicted the
// app's entire E2E promise.

// The upload pipeline itself lives in server/uploads.js (plan step 21) and is
// now required by routes/photos.js, which owns both the upload and the serving.

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
const gameRoutes = require('./routes/games');
const ritualRoutes = require('./routes/rituals');
const { uploadRoute, filesRoute } = require('./routes/photos');
const profileRoutes = require('./routes/profile');
const pairingRoutes = require('./routes/pairing');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');

app.use('/api', authRoutes());
app.use('/api/letters', letterRoutes());
app.use(opsRoutes());
app.use('/api/games', gameRoutes());
app.use('/api/rituals', ritualRoutes());
app.use('/api', profileRoutes({ authenticateToken }));
app.use('/api', pairingRoutes({ authenticateToken, perUser, writeMax: WRITE_MAX, log }));
app.use('/api/notifications', notificationRoutes({ authenticateToken }));
app.use('/api', adminRoutes({ authenticateToken, isProd, log }));
app.use('/api/photos', uploadRoute({ authenticateToken, perUser, writeMax: WRITE_MAX, uploadsDir, log }));
// NOT express.static. A static mount cannot ask who is asking, and every file
// in this directory is somebody's photograph. See routes/photos.js.
app.use('/uploads', filesRoute({ authenticateToken, uploadsDir, log }));


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
