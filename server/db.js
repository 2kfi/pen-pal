const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'penpal.db');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, friendly_name TEXT,
  email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, public_key TEXT,
  encrypted_private_key TEXT, pid TEXT UNIQUE NOT NULL, age INTEGER, birthday TEXT,
  favorite_food TEXT, bio TEXT DEFAULT '', avatar_url TEXT, profile_data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user1_id INTEGER NOT NULL, user2_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
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
`;

function initDB() {
  if (db) return db;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  // Legacy sql.js files are plain SQLite files, so better-sqlite3 opens them
  // directly — opening the existing data/penpal.db IS the migration.
  // If the file is corrupt, fall back to a fresh init.
  try {
    db = new Database(dbPath);
  } catch (err) {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    db = new Database(dbPath);
  }
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function getDb() {
  if (!db) return initDB();
  return db;
}

function resetDB() {
  getDb().exec('DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS pairs; DROP TABLE IF EXISTS letters; DROP TABLE IF EXISTS pairings; DROP TABLE IF EXISTS notifications; DROP TABLE IF EXISTS photos;');
  getDb().exec(SCHEMA);
}

function closeDB() {
  if (db) {
    try {
      db.close();
    } catch {
      // ponytail: ignore double-close
    }
    db = null;
  }
}

module.exports = { initDB, getDb, resetDB, closeDB };
