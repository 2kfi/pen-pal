const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');

/**
 * Auth middleware and helpers shared by every route module.
 *
 * These live here rather than in index.js so that route modules can be split
 * out of the server without five of them editing the same file. Each route
 * module requires this and nothing else from the app entrypoint.
 *
 * --- Auth v2 (plan step 20) -----------------------------------------------
 *
 * v0.0.2 put a 7-day JWT in `localStorage` and called that authentication.
 * Any XSS on the origin — one injected `<script>`, one malicious npm postinstall,
 * one bad `marked` upgrade — could read `localStorage.pp_token` and exfiltrate a
 * token that stayed valid for a week, from any machine, forever. An httpOnly
 * cookie is not reachable from JavaScript at all, so that entire class of loss
 * disappears rather than being mitigated.
 *
 * The shape now:
 *
 *   access token   15 minutes, held in a JS closure. Sent as a bearer header,
 *                  never written anywhere that survives a reload.
 *   refresh token  30 days, httpOnly + SameSite=Strict cookie, scoped to
 *                  /api/auth so it is not attached to any other API request.
 *                  Stored server-side as a SHA-256 hash: a database read gives
 *                  an attacker nothing, because the plaintext only exists in
 *                  the cookie the user already holds.
 *
 * Refresh tokens ROTATE. Every refresh mints a new token and invalidates the
 * old one; presenting an already-rotated token is treated as theft and revokes
 * the entire token family (see rotateSession). Because rotation makes every
 * token single-use, "reuse" is unambiguous — there is no legitimate way to
 * present a dead token.
 */

const DEFAULT_SECRET = 'dev-only-insecure-secret';

const DEFAULT_SECRETS = ['change-this-secret', 'change-this-to-a-secure-random-secret'];

/** The signing secret, with the same fail-loud behaviour the app has always had. */
function resolveSecret() {
  const configured = process.env.JWT_SECRET;
  if (!configured || DEFAULT_SECRETS.includes(configured)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set to a non-default value');
    }
    return DEFAULT_SECRET;
  }
  return configured;
}

const SECRET = resolveSecret();

/* ------------------------------------------------------------------ *
 * Token lifetimes
 * ------------------------------------------------------------------ */

/**
 * The access token is deliberately short. It lives in memory, so closing the
 * tab ends it — but "the tab has been open for a week" is still a real window,
 * and a short life bounds it. 15 minutes is long enough that nobody sees a
 * refresh round-trip, short enough that a leaked one is nearly worthless.
 */
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Long, but revocable. The cookie carries a Max-Age to match. */
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;

const REFRESH_COOKIE = 'pp_refresh';
/**
 * Scoped as tightly as possible while still letting the logout endpoint see it:
 * the cookie is attached to /api/auth/* and to nothing else in the app. An exact
 * `/api/auth/refresh` path would be narrower still, but then POST /api/auth/logout
 * would never receive the cookie and a user with an expired access token could
 * not revoke their own session — which is precisely the case logout exists for.
 */
const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * CSRF defence for the cookie-driven endpoints.
 *
 * A browser will not let a cross-site page set a custom header without first
 * passing a CORS preflight, and a preflight response cannot be forged by a form
 * post or an <img>. So requiring `X-Requested-With: penpal` turns the refresh
 * endpoint from "any site can hit this with the user's cookie attached" into
 * "only our own JS can". See the residual-risk note in routes/auth.js.
 */
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'penpal';

/* ------------------------------------------------------------------ *
 * Access tokens
 * ------------------------------------------------------------------ */

/**
 * Mint an access token. `sid` ties the token to a session row so that revoking
 * a session takes effect immediately instead of whenever the token happens to
 * expire — without that, "sign this device out" would be a lie for up to 15
 * minutes.
 */
function signAccessToken(user, sid) {
  const payload = { id: user.id, username: user.username, pid: user.pid };
  if (sid) payload.sid = sid;
  return jwt.sign(payload, SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

/* ------------------------------------------------------------------ *
 * Sessions (refresh tokens)
 * ------------------------------------------------------------------ */

const SESSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_at TEXT,
  family_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions(family_id);
`;

/**
 * Create the sessions table on demand.
 *
 * The migration runner (server/lib/migrations/030-auth-sessions.js) is the
 * declared path for this, but auth must not depend on the runner having run:
 * a self-hosted instance that upgrades and restarts has no rows in
 * `_migrations`, and `npm test` runs against a throwaway database. Both paths
 * use IF NOT EXISTS, so running them twice is harmless.
 */
function ensureSessionsSchema(db = getDb()) {
  db.exec(SESSIONS_SCHEMA);
  return db;
}

const schemasEnsured = new WeakSet();
function ensureOnce(db) {
  if (schemasEnsured.has(db)) return db;
  ensureSessionsSchema(db);
  schemasEnsured.add(db);
  return db;
}

/**
 * Refresh tokens are 256 bits of CSPRNG output. Their SHA-256 is what we store:
 * a stolen database backup contains hashes, and hashes cannot be replayed
 * without also having the cookie.
 */
function newRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const newId = () => crypto.randomBytes(16).toString('hex');

const nowIso = () => new Date().toISOString();
const inMs = (ms) => new Date(Date.now() + ms).toISOString();

/**
 * Issue a refresh token and open a session.
 *
 * @param {object} db better-sqlite3 handle
 * @param {{id:number, username:string, pid:string}} user
 * @param {{userAgent?:string, familyId?:string}} opts a familyId is inherited
 *   on rotation; omit it to start a brand-new token family.
 */
function issueSession(db, user, { userAgent = '', familyId = newId() } = {}) {
  ensureOnce(db);
  const token = newRefreshToken();
  const id = newId();
  const expiresAt = inMs(REFRESH_TOKEN_TTL_MS);
  db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, user_agent, created_at, expires_at, revoked_at, rotated_at, family_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, user.id, hashRefreshToken(token), String(userAgent).slice(0, 300), nowIso(), expiresAt, familyId);

  return { token, sessionId: id, familyId, expiresAt };
}

const USER_COLUMNS = 'id, username, friendly_name, email, pid, public_key, encrypted_private_key, age, birthday, favorite_food, bio, avatar_url';

/**
 * Consume a refresh token and issue its replacement.
 *
 * The failure modes are deliberately indistinguishable to the caller — every
 * one returns `{ ok: false }` — because a client that can tell "expired" from
 * "stolen" learns something about the server's state.
 *
 * `reuse` is the interesting one. Rotation makes every token single-use, so a
 * *live* token whose row is already dead can only mean one of two things: the
 * legitimate client raced itself, or somebody replayed a token they should not
 * have (e.g. recovered from an old backup or a proxy log). OAuth 2 BCP calls
 * this token replay, and the standard response is to revoke the entire family —
 * both the attacker's token and the victim's, forcing a fresh login rather than
 * leaving the attacker and the user to fight over one session.
 */
function rotateSession(db, presented, { userAgent = '' } = {}) {
  ensureOnce(db);
  if (typeof presented !== 'string' || presented.length < 16) return { ok: false, reason: 'invalid' };

  const row = db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(hashRefreshToken(presented));
  if (!row) return { ok: false, reason: 'invalid' };

  const at = nowIso();
  if (row.revoked_at || row.rotated_at) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(at, row.family_id);
    return { ok: false, reason: 'reuse', familyId: row.family_id };
  }

  if (row.expires_at <= at) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, row.id);
    return { ok: false, reason: 'expired' };
  }

  const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(row.user_id);
  if (!user) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(at, row.id);
    return { ok: false, reason: 'invalid' };
  }

  // Invalidate the presented token in the same transaction that mints its
  // replacement: a crash between the two must leave the old token dead, never
  // two live tokens.
  const swap = db.transaction(() => {
    db.prepare('UPDATE sessions SET revoked_at = ?, rotated_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, at, row.id);
    return issueSession(db, user, { userAgent, familyId: row.family_id });
  });
  const next = swap();

  return {
    ok: true,
    user,
    ...next,
    accessToken: signAccessToken(user, next.sessionId),
    replacedSessionId: row.id,
  };
}

function revokeSession(db, sessionId, userId) {
  ensureOnce(db);
  const at = nowIso();
  // user_id is in the WHERE on purpose: a session id is not a capability, and
  // one user must never be able to revoke another's session by guessing.
  const info = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(at, sessionId, userId);
  return info.changes > 0;
}

function revokeAllSessions(db, userId) {
  ensureOnce(db);
  const at = nowIso();
  const info = db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, userId);
  return info.changes;
}

function revokeFamily(db, familyId) {
  ensureOnce(db);
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(nowIso(), familyId).changes;
}

/** Sessions for the "your devices" screen. Revoked/rotated rows are kept for 30 days of forensics. */
function listSessions(db, userId, currentSessionId) {
  ensureOnce(db);
  return db
    .prepare(
      `SELECT id, user_agent AS userAgent, created_at AS createdAt, expires_at AS expiresAt,
              revoked_at AS revokedAt, family_id AS familyId,
              CASE WHEN id = ? THEN 1 ELSE 0 END AS current
       FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(currentSessionId ?? '', userId);
}

/** The row behind a refresh cookie, if it is still alive. */
function sessionFor(db, sessionId) {
  ensureOnce(db);
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) ?? null;
}

/* ------------------------------------------------------------------ *
 * Cookie plumbing
 * ------------------------------------------------------------------ */

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function refreshTokenFrom(req) {
  return readCookie(req, REFRESH_COOKIE);
}

function cookieAttributes() {
  return {
    httpOnly: true,
    // Strict, not Lax. The app is served from the same origin as its API, so
    // no legitimate flow needs the cookie on a cross-site request; Lax would
    // only widen the window for nothing.
    sameSite: 'strict',
    // A cookie marked Secure is ignored entirely over plain HTTP, which would
    // silently break every LAN deployment (the normal self-hosted case) — so it
    // follows NODE_ENV, exactly as the CSP does not force HSTS.
    secure: process.env.NODE_ENV === 'production',
    path: REFRESH_COOKIE_PATH,
  };
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, { ...cookieAttributes(), maxAge: REFRESH_TOKEN_TTL_MS });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, cookieAttributes());
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

/** Prepared-statement cache. better-sqlite3 wants these compiled once, not per request. */
const sessionStmtCache = new WeakMap();

/**
 * Is the session behind this access token still alive?
 *
 * Returns true for tokens minted before auth v2 (no `sid` claim) so that an
 * upgrade does not invalidate every logged-in browser mid-letter. Those tokens
 * still expire on their own 7-day schedule.
 */
function sessionIsActive(db, sid) {
  if (!sid) return true;
  let stmt = sessionStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare('SELECT revoked_at, expires_at FROM sessions WHERE id = ?');
    sessionStmtCache.set(db, stmt);
  }
  const row = stmt.get(sid);
  if (!row) return false;
  return !row.revoked_at && row.expires_at > nowIso();
}

/**
 * Requires a valid bearer token. Populates `req.user` with the JWT payload
 * `{ id, username, pid, sid }`.
 *
 * 401 for a missing or *expired* token — an expired one is routine and is what
 * the client's silent refresh is built around. 403 for one that fails
 * verification for any other reason (tampered, wrong secret), kept distinct
 * from v0.0.2's behaviour.
 */
function authenticateToken(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(err.name === 'TokenExpiredError' ? 401 : 403);
    try {
      if (!sessionIsActive(getDb(), user.sid)) return res.sendStatus(401);
    } catch {
      // A database that cannot be read must not become a way in.
      return res.sendStatus(401);
    }
    req.user = user;
    next();
  });
}

/**
 * Rejects a state-changing request that a browser could have been made to send
 * from another site. See the CSRF note above: the custom header is the control,
 * SameSite=Strict is the second layer.
 */
function requireSameOriginClient(req, res, next) {
  if (req.get(CSRF_HEADER) !== CSRF_VALUE) {
    return res.status(403).json({ error: 'Missing or invalid X-Requested-With header' });
  }
  next();
}

/**
 * A syntactically valid bcrypt hash of a value nobody can supply. Used to spend
 * comparable CPU on the "user does not exist" path so a missing account does
 * not respond measurably faster than a wrong password.
 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

/** Manual validation (no new deps): returns an error string, or null. */
function checkStr(value, { required = false, min = 0, max = 1024 } = {}) {
  if (value === undefined || value === null) return required ? 'missing required field' : null;
  if (typeof value !== 'string') return 'must be a string';
  if (value.length < min) return `must be at least ${min} chars`;
  if (value.length > max) return `must be at most ${max} chars`;
  return null;
}

/** Six uppercase alphanumeric characters. Retries rather than trusting chance. */
function generatePID(db) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pid = Math.random().toString(36).substring(2, 8).toUpperCase().padEnd(6, 'X');
    if (!db || !db.prepare('SELECT 1 FROM users WHERE pid = ?').get(pid)) return pid;
  }
  // Astronomically unlikely. Failing loudly beats a duplicate address.
  throw new Error('could not allocate a unique PID');
}

module.exports = {
  SECRET,
  authenticateToken,
  checkStr,
  generatePID,
  DUMMY_HASH,

  // auth v2
  ACCESS_TOKEN_TTL,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_DAYS,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  CSRF_HEADER,
  CSRF_VALUE,
  USER_COLUMNS,
  ensureSessionsSchema,
  signAccessToken,
  issueSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  revokeFamily,
  listSessions,
  sessionFor,
  sessionIsActive,
  readCookie,
  refreshTokenFrom,
  setRefreshCookie,
  clearRefreshCookie,
  requireSameOriginClient,
};
