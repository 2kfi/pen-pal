'use strict';

/**
 * 030 — auth v2: per-device sessions (plan step 20).
 *
 * v0.0.2 had no sessions at all. One 7-day JWT lived in `localStorage` on one
 * device; "sign out everywhere" was impossible, "which devices are signed in"
 * was unknowable, and revoking a stolen token required rotating JWT_SECRET,
 * which signs out the pen pal as well.
 *
 * Each row here is one device's refresh credential. `refresh_hash` is a
 * SHA-256 digest — a copy of this database is not a set of usable tokens. The
 * `family_id` column is what makes rotation detection possible: a refresh token
 * is single-use, so presenting one whose row is already dead means it leaked,
 * and the whole family dies with it.
 *
 * Additive only. Existing users are untouched; they simply have no session rows
 * until they sign in again.
 */

module.exports = {
  name: 'auth-sessions',

  up(db) {
    db.exec(`
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
    `);
  },
};
