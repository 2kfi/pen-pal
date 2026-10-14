/**
 * 001 — the baseline schema.
 *
 * Everything v2 expects to exist, created with `IF NOT EXISTS` so it is a no-op
 * against a database that already has the tables. It deliberately does NOT
 * create `pairs`: reshaping that table is 020's job, and 020 needs to be able to
 * tell "there is no pairs table" apart from "there is a pairs table in the old
 * shape" apart from "there is a pairs table in the new shape".
 *
 * Nothing in here is destructive. Running this migration twice cannot lose data,
 * which is why the runner still records it in the ledger: so that a later
 * migration can rely on "001 has run".
 *
 * The old v0.0.2 schema for all of these tables was byte-identical to this, so
 * an upgrade touches none of them. See docs/MIGRATION.md.
 */

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, friendly_name TEXT,
  email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, public_key TEXT,
  encrypted_private_key TEXT, pid TEXT UNIQUE NOT NULL, age INTEGER, birthday TEXT,
  favorite_food TEXT, bio TEXT DEFAULT '', avatar_url TEXT, profile_data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);

-- One row PER USER, not per relationship.
--
-- v0.0.2 stored one row per pairing (user1_id, user2_id) with no uniqueness at
-- all, so a user could hold many pairs, and the lookup
-- "SELECT * FROM pairs WHERE user1_id = ? OR user2_id = ?" returned an arbitrary
-- one -- which is how a letter could be silently delivered to the wrong partner.
-- A UNIQUE index cannot fix that on a two-column table (a user can appear as
-- user1 in one row and user2 in another). Making user_id the PRIMARY KEY makes
-- "one partner at a time" a storage guarantee, not a convention.
-- The shape below is what 020 creates and converts to; see 020 for the upgrade
-- from the v0.0.2 two-column table.
--
--   pairs(user_id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL, created_at ...)

CREATE TABLE IF NOT EXISTS letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
  encrypted_content TEXT NOT NULL, encrypted_metadata TEXT, photo_paths TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME, sync_version INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pairings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL, target_pid TEXT NOT NULL,
  status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT, read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, letter_id INTEGER,
  filename TEXT NOT NULL, filepath TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_letters_sender_recipient ON letters(sender_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_pairings_status ON pairings(status);
CREATE INDEX IF NOT EXISTS idx_letters_recipient ON letters(recipient_id, delivered_at);
`;

module.exports = {
  name: 'base-schema',
  BASE_SCHEMA,
  up(db) {
    db.exec(BASE_SCHEMA);
  },
};
