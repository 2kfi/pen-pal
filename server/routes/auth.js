'use strict';

/**
 * /api/auth/* — signup, login, refresh, logout, and per-device sessions
 * (plan step 20).
 *
 * Mounted at /api:
 *
 *     const authRoutes = require('./routes/auth');
 *     app.use('/api', authRoutes());
 *
 * which yields POST /api/auth/login, /api/auth/signup, /api/auth/refresh,
 * /api/auth/logout, /api/auth/sessions, plus the flat /api/login and
 * /api/signup aliases the existing client and tests already call.
 *
 * Body shapes for login and signup are UNCHANGED. The response is unchanged
 * too: `{ token, user }`. What changed is what `token` means — it is now a
 * 15-minute access token rather than a 7-day everything-token, and the durable
 * credential moved into an httpOnly cookie the JavaScript cannot read.
 *
 * ---------------------------------------------------------------------------
 * CSRF, honestly
 * ---------------------------------------------------------------------------
 * Refresh, logout and session revocation are driven entirely by a cookie, so
 * they are the app's only CSRF surface. Three controls, in order of strength:
 *
 *   1. SameSite=Strict on the refresh cookie. A cross-site request does not
 *      carry it, so an attacker's page cannot even use it. This alone stops the
 *      classic attack.
 *   2. A required `X-Requested-With: penpal` header. A custom header cannot be
 *      set by an HTML form, an <img>, or a redirect — it needs fetch/XHR, which
 *      triggers a CORS preflight the attacker's origin cannot pass. Belt and
 *      braces, because SameSite has shipped browser bugs before.
 *   3. Same-origin by construction: the SPA is served from the API's own
 *      origin, so there is no legitimate cross-origin caller at all.
 *
 * Residual risk, stated plainly:
 *
 *   - If PenPal is ever deployed such that the app and the API are DIFFERENT
 *     sites, SameSite=Strict stops working (the cookie is not sent) and control
 *     2 becomes the only thing standing there. It is a real control, but a
 *     preflight-based defence is strictly weaker than an origin check: a
 *     misconfigured CORS policy (`Access-Control-Allow-Origin: *` plus
 *     allow-credentials mistakes, or a reflected origin) would turn it into no
 *     control at all. CORS_ORIGIN in production should stay unset or strict.
 *   - The header check is on the request, not the response. An attacker who can
 *     already read responses cross-origin has bigger problems; but nothing here
 *     defends against that.
 *   - A subdomain takeover or an XSS on the app's own origin defeats all of
 *     this. Same-origin XSS can simply call these endpoints with the right
 *     header — the httpOnly cookie is what stops it *stealing* a token for later
 *     use elsewhere, not from acting while the user is present.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { getDb } = require('../db');
const {
  authenticateToken,
  requireSameOriginClient,
  checkStr,
  generatePID,
  DUMMY_HASH,
  ACCESS_TOKEN_TTL,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_DAYS,
  USER_COLUMNS,
  ensureSessionsSchema,
  hashRefreshToken,
  signAccessToken,
  issueSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  listSessions,
  refreshTokenFrom,
  setRefreshCookie,
  clearRefreshCookie,
} = require('../lib/auth');

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

/** The public shape the client has always received, byte for byte. */
function userPayload(row) {
  return {
    id: row.id,
    username: row.username,
    friendly_name: row.friendly_name,
    email: row.email,
    pid: row.pid,
    publicKey: row.public_key,
    encryptedPrivateKey: row.encrypted_private_key,
    age: row.age,
    birthday: row.birthday,
    favorite_food: row.favorite_food,
    bio: row.bio,
    avatar_url: row.avatar_url,
  };
}

/**
 * Sign in and open a session: a fresh family, a refresh cookie, and a short
 * access token for the page to hold in memory.
 */
function startSession(req, res, user) {
  const session = issueSession(getDb(), user, { userAgent: req.get('user-agent') || '' });
  setRefreshCookie(res, session.token);
  return {
    token: signAccessToken(user, session.sessionId),
    user: userPayload(user),
    session: {
      id: session.sessionId,
      expiresAt: session.expiresAt,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
  };
}

/** The live session behind a presented refresh cookie, or null. */
function sessionFromCookie(req) {
  const presented = refreshTokenFrom(req);
  if (!presented) return null;
  return getDb().prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(hashRefreshToken(presented)) ?? null;
}

module.exports = function authRoutes() {
  const router = express.Router();
  ensureSessionsSchema();

  // Same budget as v0.0.2: these limits are sized for a self-hosted instance
  // with a handful of people on it, not for public multi-tenant SaaS.
  const windowMs = Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000);
  const common = { windowMs, standardHeaders: true, legacyHeaders: false };
  const signupLimit = rateLimit({ ...common, limit: Number(process.env.SIGNUP_RATE_MAX || 120) });
  const loginLimit = rateLimit({ ...common, limit: Number(process.env.LOGIN_RATE_MAX || 60) });

  /* ---------------------------------------------------------------- *
   * Signup
   * ---------------------------------------------------------------- */

  const signupHandler = async (req, res) => {
    const { username, email, password, publicKey, encryptedPrivateKey, profileData } = req.body || {};
    const bad =
      checkStr(username, { required: true, min: 1, max: 64 }) ||
      checkStr(email, { required: true, min: 3, max: 254 }) ||
      checkStr(password, { required: true, min: 8, max: 256 });
    if (bad || !email.includes('@')) {
      return res.status(400).json({ error: `Invalid signup body: ${bad || 'email must contain @'}` });
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const pid = generatePID();
      const friendlyName = profileData?.friendlyName || username;
      const bio = profileData?.bio || '';

      const info = getDb()
        .prepare(`INSERT INTO users (username, email, password_hash, public_key, encrypted_private_key, pid, friendly_name, bio, profile_data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(username, email, hashedPassword, publicKey || '', encryptedPrivateKey || '', pid, friendlyName, bio, JSON.stringify(profileData || {}));

      const user = {
        id: Number(info.lastInsertRowid),
        username,
        email,
        pid,
        friendly_name: friendlyName,
        public_key: publicKey || '',
        encrypted_private_key: encryptedPrivateKey || '',
        bio,
      };
      res.json(startSession(req, res, user));
    } catch (err) {
      log('Signup error', { error: err.message });
      res.status(400).json({ error: 'Username or email already exists' });
    }
  };

  /* ---------------------------------------------------------------- *
   * Login
   * ---------------------------------------------------------------- */

  const loginHandler = async (req, res) => {
    const { email, password } = req.body || {};
    const bad = checkStr(email, { required: true, min: 3, max: 254 }) || checkStr(password, { required: true, min: 1, max: 256 });
    if (bad) return res.status(400).json({ error: `Invalid login body: ${bad}` });
    try {
      // password_hash is selected here and ONLY here. USER_COLUMNS is a public
      // projection that omits it deliberately — reusing it made
      // bcrypt.compare(password, undefined) and turned every successful login
      // into a 500, while the wrong-password path still returned a correct 401.
      const user = getDb()
        .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`)
        .get(email);
      // Identical response for "no such user" and "wrong password". v0.0.2 returned
      // "User not found" vs "Invalid password" — a free account-enumeration oracle
      // for anyone holding a list of email addresses.
      if (!user) {
        // Burn comparable time so the response does not leak existence either.
        await bcrypt.compare(password, DUMMY_HASH);
        return res.status(401).json({ error: 'Email or password is incorrect' });
      }

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) return res.status(401).json({ error: 'Email or password is incorrect' });

      res.json(startSession(req, res, user));
    } catch (err) {
      log('Login error', { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /* ---------------------------------------------------------------- *
   * Refresh — the only cookie-driven, state-changing endpoint that
   * can mint a working access token.
   * ---------------------------------------------------------------- */

  router.post('/auth/refresh', requireSameOriginClient, (req, res) => {
    const presented = refreshTokenFrom(req);
    if (!presented) return res.status(401).json({ error: 'No session' });

    const result = rotateSession(getDb(), presented, { userAgent: req.get('user-agent') || '' });
    if (!result.ok) {
      // 'reuse' means a token we already rotated came back. That is either a
      // thief replaying a token they should not hold or a legitimately stolen
      // backup — either way the whole family is dead and the user is logged
      // out. Nothing about which it was is revealed in the response.
      if (result.reason === 'reuse') {
        log('Refresh token reuse detected — session family revoked', { family: result.familyId });
      }
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Session expired' });
    }

    setRefreshCookie(res, result.token);
    res.json({
      token: result.accessToken,
      user: userPayload(result.user),
      session: {
        id: result.sessionId,
        expiresAt: result.expiresAt,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    });
  });

  /* ---------------------------------------------------------------- *
   * Logout
   * ---------------------------------------------------------------- */

  /**
   * Revokes exactly the session the cookie belongs to, and clears the cookie.
   *
   * Deliberately NOT bearer-authenticated: the whole point is to be able to end
   * a session whose access token has already expired. The CSRF header plus
   * SameSite=Strict is what makes a cookie-only endpoint safe here.
   */
  router.post('/auth/logout', requireSameOriginClient, (req, res) => {
    const row = sessionFromCookie(req);
    const revoked = row && !row.revoked_at && revokeSession(getDb(), row.id, row.user_id) ? 1 : 0;
    clearRefreshCookie(res);
    res.json({ success: true, revoked });
  });

  /** Nuclear option: end every session on every device. */
  router.post('/auth/logout-all', requireSameOriginClient, (req, res) => {
    const row = sessionFromCookie(req);
    const count = row ? revokeAllSessions(getDb(), row.user_id) : 0;
    clearRefreshCookie(res);
    res.json({ success: true, revoked: count });
  });

  /* ---------------------------------------------------------------- *
   * Per-device sessions
   * ---------------------------------------------------------------- */

  router.get('/auth/sessions', authenticateToken, (req, res) => {
    res.json({
      sessions: listSessions(getDb(), req.user.id, req.user.sid),
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenDays: REFRESH_TOKEN_DAYS,
    });
  });

  /** Revoke one device. Users may revoke their own sessions and nothing else. */
  router.post('/auth/sessions/revoke', authenticateToken, requireSameOriginClient, (req, res) => {
    const { sessionId } = req.body || {};
    if (checkStr(sessionId, { required: true, min: 8, max: 64 })) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const current = sessionId === req.user.sid;
    if (!revokeSession(getDb(), sessionId, req.user.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (current) clearRefreshCookie(res);
    res.json({ success: true, current });
  });

  /** "Sign out everywhere else" — keeps the calling device alive. */
  router.post('/auth/sessions/revoke-others', authenticateToken, requireSameOriginClient, (req, res) => {
    const db = getDb();
    const count = db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), req.user.id, req.user.sid ?? '')
      .changes;
    res.json({ success: true, revoked: count });
  });

  /* ---------------------------------------------------------------- *
   * The paths the existing client already calls.
   *
   * Same bodies, same responses. Kept as aliases rather than redirects so that
   * the rate limiter and the cookie behaviour are identical on both.
   * ---------------------------------------------------------------- */

  router.post('/auth/login', loginLimit, loginHandler);
  router.post('/login', loginLimit, loginHandler);
  router.post('/auth/signup', signupLimit, signupHandler);
  router.post('/signup', signupLimit, signupHandler);

  return router;
};
