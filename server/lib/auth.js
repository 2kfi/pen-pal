const jwt = require('jsonwebtoken');

/**
 * Auth middleware and helpers shared by every route module.
 *
 * These live here rather than in index.js so that route modules can be split
 * out of the server without five of them editing the same file. Each route
 * module requires this and nothing else from the app entrypoint.
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

/**
 * Requires a valid bearer token. Populates `req.user` with the JWT payload
 * `{ id, username, pid }`.
 *
 * 401 for a missing/unparseable token, 403 for one that fails verification —
 * kept distinct from v0.0.2's behaviour.
 */
function authenticateToken(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
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
};