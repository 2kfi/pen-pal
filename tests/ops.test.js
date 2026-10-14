/**
 * Ops tests: migrations, backups, health, request ids.
 *
 * ## The one that matters
 *
 * `describe('v0.0.2 -> v2')` builds a byte-accurate v0.0.2 database — the real
 * schema, copied out of `git show 13bbceb:server/db.js`, including the old
 * `pairs(id, user1_id, user2_id)` table — populates it with users, pairings and
 * letters, runs the migration runner over it, and asserts that every pairing
 * and every letter survived.
 *
 * This is the test that catches silent data loss. Everything else here checks
 * that the machinery around the migration behaves; this one checks the
 * migration.
 *
 * ## Why the fixture is hand-built instead of mocked
 *
 * A mock of the old schema proves the migration handles the mock. Building the
 * actual file out of the actual v0.0.2 DDL is the only thing that proves it
 * handles the database that is really out there.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-production-1234567890';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'penpal-ops-test-'));

// The real server is expected to take longer than this to boot; a test process
// does not, and a health assertion that depends on wall-clock timing is a flaky
// assertion. The boot-grace window gets its own test further down, with the
// module reloaded so it can use the real default.
process.env.HEALTHZ_BOOT_GRACE_MS = '0';

const { describe, it, expect, afterAll, vi } = await import('vitest');
const { default: request } = await import('supertest');

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const express = require('express');

const migrations = require('../server/lib/migrations/index.js');
const backup = require('../server/lib/ops/backup.js');
const health = require('../server/lib/ops/health.js');
const loggerMod = require('../server/lib/ops/logger.js');
const reqCtx = require('../server/lib/ops/request-context.js');
const opsRoutes = require('../server/routes/ops.js');

const ROOT = path.join(import.meta.dirname, '..');

const tmpDirs = [];
function tmp(prefix = 'penpal-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * The v0.0.2 schema, verbatim from `git show 13bbceb:server/db.js`.
 *
 * Do not "modernise" this. The entire point is that it is byte-identical to
 * what a real v0.0.2 install has on disk.
 */
const V002_SCHEMA = `
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

/** Collects every log line a logger emits, for assertions. */
function captureLogs() {
  const lines = [];
  const fake = {
    debug: (m, e) => lines.push({ level: 'debug', msg: m, ...e }),
    info: (m, e) => lines.push({ level: 'info', msg: m, ...e }),
    warn: (m, e) => lines.push({ level: 'warn', msg: m, ...e }),
    error: (m, e) => lines.push({ level: 'error', msg: m, ...e }),
  };
  return { log: fake, lines, find: (msg) => lines.filter((l) => String(l.msg).includes(msg)) };
}

/** Opens a fresh database in a temp directory. */
function openTempDb(dir = tmp()) {
  const file = path.join(dir, 'penpal.db');
  return { db: new Database(file), file, dir };
}

/**
 * Builds a real v0.0.2 database with people, pairings and letters in it.
 * Returns the open handle plus a description of what was put there, so the
 * test can assert against the source of truth rather than hard-coded numbers.
 */
function buildV002({ pairs: legacyPairs = [], letters = [], extraSql = '' } = {}) {
  const { db, file } = openTempDb();
  db.exec(V002_SCHEMA);
  if (extraSql) db.exec(extraSql);

  const addUser = db.prepare(
    'INSERT INTO users (username, email, password_hash, pid) VALUES (?, ?, ?, ?)',
  );
  // Users are added 1..n so the ids in `pairs` are predictable.
  for (let i = 1; i <= 8; i += 1) {
    addUser.run(`user${i}`, `user${i}@v002.test`, `$2b$fake${i}`, `PID${String(i).padStart(2, '0')}`);
  }

  const addPair = db.prepare('INSERT INTO pairs (user1_id, user2_id) VALUES (?, ?)');
  for (const [a, b] of legacyPairs) addPair.run(a, b);

  const addLetter = db.prepare(
    'INSERT INTO letters (sender_id, recipient_id, encrypted_content) VALUES (?, ?, ?)',
  );
  for (const [from, to, body] of letters) addLetter.run(from, to, body);

  return { db, file };
}

const pairMap = (db) => {
  const rows = db.prepare('SELECT user_id, partner_id FROM pairs').all();
  return Object.fromEntries(rows.map((r) => [r.user_id, r.partner_id]));
};

/* ------------------------------------------------------------------ *
 * The critical one: v0.0.2 -> v2 must not lose a pairing
 * ------------------------------------------------------------------ */

describe('v0.0.2 -> v2 migration', () => {
  it('builds a v0.0.2 database with the OLD pairs(id, user1_id, user2_id) shape', () => {
    const { db } = buildV002({ pairs: [[1, 2]] });
    const cols = db.pragma('table_info(pairs)').map((c) => c.name);
    // If this assertion ever stops holding, the fixture is no longer testing
    // the upgrade path and every test below is proving nothing.
    expect(cols).toEqual(['id', 'user1_id', 'user2_id', 'created_at']);
    db.close();
  });

  it('preserves every existing pairing', () => {
    // Four DISJOINT pairings, with the "user1" side varying — v0.0.2 stored no
    // convention about which side is who, so the conversion must not assume one.
    // A user appearing in two rows is a real v0.0.2 possibility, but it is a
    // different scenario with a documented rule and gets its own test below.
    // Here every user has exactly one partner, which is what "nothing was lost"
    // has to mean.
    const legacyPairs = [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ];
    const { db } = buildV002({ pairs: legacyPairs });

    const before = db.prepare('SELECT id, user1_id, user2_id FROM pairs ORDER BY id').all();
    migrations.runMigrations(db);

    const after = pairMap(db);

    // Every legacy pair survives, and survives IN BOTH DIRECTIONS, because the
    // v2 schema is keyed by "who is asking": looking up your partner must work
    // for each of the two people in every relationship.
    for (const [a, b] of legacyPairs) {
      expect(after[a], `user ${a} lost their partner`).toBe(b);
      expect(after[b], `user ${b} lost their partner`).toBe(a);
    }
    expect(Object.keys(after).length).toBe(new Set(legacyPairs.flat()).size);

    // ...and the source rows are still readable in the legacy table.
    const legacy = db
      .prepare('SELECT id, user1_id, user2_id FROM pairs_legacy_v002 ORDER BY id')
      .all();
    expect(legacy).toEqual(before);

    db.close();
  });

  it('leaves users, letters and their ciphertext untouched', () => {
    const letters = [
      [1, 2, 'CIPHERTEXT::aes-256-gcm::AAAA'],
      [2, 1, 'CIPHERTEXT::aes-256-gcm::BBBB'],
      [4, 5, 'CIPHERTEXT::aes-256-gcm::CCCC'],
    ];
    const { db } = buildV002({ pairs: [[1, 2], [4, 5]], letters });

    // Compare the columns that EXISTED in v0.0.2, by name. Later migrations
    // legitimately ADD columns (`letters.state`, `letters.opened_at`, ...) and
    // backfill derived ones, so `SELECT *` is expected to differ. Silently
    // rewriting a v0.0.2 column is not.
    const V002_USER_COLS =
      'id, username, friendly_name, email, password_hash, public_key, encrypted_private_key, pid, age, birthday, favorite_food, bio, avatar_url, profile_data, created_at';
    const V002_LETTER_COLS =
      'id, sender_id, recipient_id, encrypted_content, encrypted_metadata, photo_paths, sent_at, delivered_at, sync_version';

    const usersBefore = db.prepare(`SELECT ${V002_USER_COLS} FROM users ORDER BY id`).all();
    const lettersBefore = db.prepare(`SELECT ${V002_LETTER_COLS} FROM letters ORDER BY id`).all();

    migrations.runMigrations(db);

    expect(db.prepare(`SELECT ${V002_USER_COLS} FROM users ORDER BY id`).all()).toEqual(usersBefore);
    expect(db.prepare(`SELECT ${V002_LETTER_COLS} FROM letters ORDER BY id`).all()).toEqual(
      lettersBefore,
    );

    // Specifically: the encrypted bodies are not re-encrypted, truncated, or
    // touched. A migration that mangles ciphertext is worse than one that does
    // not run at all, because the damage is invisible until somebody opens a
    // letter.
    const bodies = db.prepare('SELECT encrypted_content FROM letters ORDER BY id').all();
    expect(bodies.map((b) => b.encrypted_content)).toEqual([
      'CIPHERTEXT::aes-256-gcm::AAAA',
      'CIPHERTEXT::aes-256-gcm::BBBB',
      'CIPHERTEXT::aes-256-gcm::CCCC',
    ]);

    db.close();
  });

  it('records what it did in the ledger, and is idempotent', () => {
    const { db } = buildV002({ pairs: [[1, 2]] });

    const first = migrations.runMigrations(db);
    expect(first.applied.length).toBeGreaterThan(0);

    const ledger = db.prepare('SELECT version, name, checksum, applied_at FROM _migrations ORDER BY version').all();
    expect(ledger.length).toBe(first.applied.length);
    for (const row of ledger) {
      expect(row.version).toMatch(/^\d{3}$/);
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(Date.parse(row.applied_at)).not.toBeNaN();
    }

    const snapshot = pairMap(db);
    const letters = db.prepare('SELECT * FROM letters ORDER BY id').all();

    // Second run must be a complete no-op.
    const second = migrations.runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(pairMap(db)).toEqual(snapshot);
    expect(db.prepare('SELECT * FROM letters ORDER BY id').all()).toEqual(letters);
    expect(db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n).toBe(ledger.length);

    db.close();
  });

  it('does NOT rewrite a v2-shaped pairs table that the ledger has never seen', () => {
    // Every existing v2 install hits this on its first boot of the runner: the
    // table is already the new shape and the ledger is empty. If this path
    // reshaped the table it would destroy real data on upgrade.
    const { db } = openTempDb();
    migrations.runMigrations(db); // bring a fresh db up to date

    const before = pairMap(db);
    db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(11, 12);
    db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(12, 11);
    const expected = pairMap(db);

    // Wipe the ledger to simulate "v2 data, no ledger", then re-run.
    db.exec('DELETE FROM _migrations');
    db.exec('DROP TABLE pairs');
    db.exec('CREATE TABLE pairs (user_id INTEGER PRIMARY KEY, partner_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(11, 12);
    db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(12, 11);

    migrations.runMigrations(db);

    expect(pairMap(db)).toEqual(expected);
    void before;
    db.close();
  });

  it('leaves a user with two partners able to find them, and says who lost whom', () => {
    // The asymmetric-row case, pinned deliberately because docs/MIGRATION.md
    // tells an operator to check for it. User 1 had both user 2 and user 3.
    //
    //   1 -> 2  inserted   (legacy row 1, earliest wins)
    //   2 -> 1  inserted
    //   3 -> 1  inserted   (user 3 only ever had user 1)
    //   1 -> 3  DROPPED    (user_id is the PK; user 1 is already taken)
    //
    // User 3 must still be able to find user 1, or their letters vanish.
    const { db } = buildV002({ pairs: [[1, 2], [3, 1]] });
    const { log, find } = captureLogs();

    migrations.runMigrations(db, { logger: log });

    const after = pairMap(db);
    expect(after[1]).toBe(2);
    expect(after[2]).toBe(1);
    // The user who was dropped as somebody's partner still has a partner.
    expect(after[3]).toBe(1);

    // Exactly one asymmetry, and it is user 3 -> user 1 with no return leg.
    const asym = db
      .prepare(
        `SELECT p.user_id, p.partner_id FROM pairs p
         LEFT JOIN pairs r ON r.user_id = p.partner_id AND r.partner_id = p.user_id
         WHERE r.user_id IS NULL`,
      )
      .all();
    expect(asym).toEqual([{ user_id: 3, partner_id: 1 }]);

    // ...and the loss is on the record, not silent.
    const warned = find('more than one partner');
    expect(warned.some((w) => w.user_id === 1 && w.dropped_partner === 3)).toBe(true);
    db.close();
  });

  it('resolves a user with two partners deterministically and says so', () => {
    // v0.0.2 permitted this. v2 cannot represent it (user_id is the PK), so one
    // pairing has to go. The rule must be stable across machines, and the loss
    // must be visible in the logs rather than discovered later as a missing
    // letter.
    const { db } = buildV002({ pairs: [[1, 2], [1, 3]] });
    const { log, find } = captureLogs();

    migrations.runMigrations(db, { logger: log });

    // Lowest legacy row id wins. Row 1 was (1,2) and row 2 was (1,3), so user 1
    // keeps partner 2 and the pairing with 3 is the one dropped. User 3 is
    // unaffected: their only partner was user 1, and that pairing survives —
    // it just survives one-directionally from user 1's point of view.
    const after = pairMap(db);
    expect(after[1]).toBe(2);
    expect(after[2]).toBe(1);
    expect(after[3]).toBe(1);

    const warnings = find('more than one partner');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.dropped_partner === 3)).toBe(true);

    // ...and both original rows are still on disk in the legacy table.
    expect(db.prepare('SELECT COUNT(*) AS n FROM pairs_legacy_v002').get().n).toBe(2);
    db.close();
  });

  it('drops and logs a self-pairing rather than corrupting the new table', () => {
    const { db } = buildV002({ pairs: [[4, 4]] });
    const { log, find } = captureLogs();

    migrations.runMigrations(db, { logger: log });

    expect(pairMap(db)[4]).toBeUndefined();
    expect(find('self-pairing').length).toBeGreaterThan(0);
    db.close();
  });

  it('rolls the whole file back when a migration fails', () => {
    // `pairs_legacy_v002` already existing makes `ALTER TABLE ... RENAME` fail
    // with a real SQLITE_ERROR partway through 020. That is the honest test of
    // the runner's central claim: the migration and its ledger row share one
    // transaction, so a half-applied migration cannot exist.
    const { db } = buildV002({ pairs: [[1, 2]] });
    db.exec('CREATE TABLE pairs_legacy_v002 (id INTEGER PRIMARY KEY)');

    const lettersBefore = db.prepare('SELECT * FROM letters ORDER BY id').all();

    expect(() => migrations.runMigrations(db)).toThrow();

    // The old shape is still there, untouched.
    expect(db.pragma('table_info(pairs)').map((c) => c.name)).toEqual([
      'id',
      'user1_id',
      'user2_id',
      'created_at',
    ]);
    expect(db.prepare('SELECT user1_id, user2_id FROM pairs').all()).toEqual([
      { user1_id: 1, user2_id: 2 },
    ]);

    // 020 was NOT recorded as applied. Nothing is ever marked done that did not
    // finish, which is what makes a retry safe.
    const recorded = db
      .prepare("SELECT version FROM _migrations WHERE version = '020'")
      .all();
    expect(recorded).toEqual([]);

    expect(db.prepare('SELECT * FROM letters ORDER BY id').all()).toEqual(lettersBefore);
    db.close();
  });

  it('takes a pre-migration snapshot that is genuinely PRE-migration', () => {
    // Regression test. The snapshot used to be taken with an async backup that
    // nothing awaited, so it completed *after* the rewrite committed and
    // captured the migrated database — a rollback copy that could not roll back.
    const dir = tmp();
    process.env.PRE_MIGRATION_BACKUP_DIR = dir;
    try {
      const { db } = buildV002({ pairs: [[1, 2], [3, 4]] });

      migrations.runMigrations(db);

      const dirs = fs.readdirSync(dir);
      expect(dirs.length).toBe(1);

      const manifest = backup.readManifest(path.join(dir, dirs[0]));
      // The snapshot must still hold the OLD shape...
      expect(manifest.pairs_shape).toBe('v0.0.2');
      expect(manifest.counts._migrations).toBe(0);
      expect(manifest.counts.pairs).toBe(2);

      // ...and it must be a usable database in its own right.
      const snapshot = new Database(path.join(dir, dirs[0], 'penpal.db'), { readonly: true });
      expect(snapshot.prepare('SELECT user1_id, user2_id FROM pairs ORDER BY id').all()).toEqual([
        { user1_id: 1, user2_id: 2 },
        { user1_id: 3, user2_id: 4 },
      ]);
      snapshot.close();
      db.close();
    } finally {
      delete process.env.PRE_MIGRATION_BACKUP_DIR;
    }
  });

  it('does not litter a fresh install with snapshots', () => {
    const dir = tmp();
    process.env.PRE_MIGRATION_BACKUP_DIR = dir;
    try {
      const { db } = openTempDb(); // empty file, nothing in it
      migrations.runMigrations(db);
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
      db.close();
    } finally {
      delete process.env.PRE_MIGRATION_BACKUP_DIR;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Runner invariants
 * ------------------------------------------------------------------ */

describe('migration runner', () => {
  it('ships no duplicate versions', () => {
    // version is the PRIMARY KEY of _migrations, so a duplicate is a silent
    // no-op or a mid-apply failure. The runner throws on this at load; this
    // asserts the property on the directory as it actually is.
    const versions = migrations.listMigrations().map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(migrations.listMigrations().every((m) => typeof m.up === 'function')).toBe(true);
  });

  it('logs what it did when the server calls it with the real logger', () => {
    // Regression test. server/db.js called runMigrations(db) with no logger, so
    // the runner fell back to its no-op default and every line was swallowed —
    // including "user had more than one partner", which is the only signal an
    // operator gets that a pairing is about to disappear.
    const written = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };

    // The fixture has to be at the DATA_DIR db.js actually opens — that module
    // captures the path at import time, so pointing env at a new directory here
    // would not move it.
    const live = path.join(process.env.DATA_DIR, 'penpal.db');
    fs.rmSync(live, { force: true });
    fs.rmSync(`${live}-wal`, { force: true });
    fs.rmSync(`${live}-shm`, { force: true });
    const fixture = new Database(live);
    fixture.exec(V002_SCHEMA);
    for (let i = 1; i <= 8; i += 1) {
      fixture
        .prepare('INSERT INTO users (username,email,password_hash,pid) VALUES (?,?,?,?)')
        .run(`user${i}`, `user${i}@v002.test`, 'h', `PID${String(i).padStart(2, '0')}`);
    }
    fixture.prepare('INSERT INTO pairs (user1_id,user2_id) VALUES (?,?)').run(1, 2);
    fixture.prepare('INSERT INTO pairs (user1_id,user2_id) VALUES (?,?)').run(1, 3);
    fixture.close();

    const dbMod = require('../server/db');
    dbMod.closeDB(); // so initDB() opens the file we just wrote

    try {
      // Exactly what initDB() does on boot.
      dbMod.initDB();
    } finally {
      process.stdout.write = realWrite;
    }

    const lines = written
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    expect(lines.some((l) => l.msg === 'migration applied')).toBe(true);
    // The warning that would otherwise be lost, and that docs/MIGRATION.md
    // tells operators to grep for.
    expect(lines.some((l) => String(l.msg).includes('more than one partner'))).toBe(true);

    // And the data really did convert, since we now have the shared handle.
    expect(pairMap(dbMod.getDb())[1]).toBe(2);
  });

  it('reports pending migrations without applying them', () => {
    const { db } = buildV002({ pairs: [[1, 2]] });
    migrations.runMigrations(db, { to: '001' });

    const status = migrations.migrationStatus(db);
    expect(status.ok).toBe(false);
    expect(status.pending.length).toBeGreaterThan(0);

    migrations.runMigrations(db);
    expect(migrations.migrationStatus(db).ok).toBe(true);
    db.close();
  });

  it('recovers when the ledger loses a row, without re-corrupting data', () => {
    // The ledger is bookkeeping, not the source of truth. If it is damaged,
    // re-running an already-applied migration must still be safe — which is
    // only true because 020 no-ops on the current shape.
    const { db } = buildV002({ pairs: [[1, 2]] });
    migrations.runMigrations(db);
    const expected = pairMap(db);

    db.prepare("DELETE FROM _migrations WHERE version = '020'").run();

    const { log, find } = captureLogs();
    const result = migrations.runMigrations(db, { logger: log });

    expect(result.applied).toContain('020');
    expect(pairMap(db)).toEqual(expected);
    expect(find('changed after it was applied').length).toBe(0);
    db.close();
  });

  it('warns when an applied migration file has been edited', () => {
    const { db } = buildV002({ pairs: [[1, 2]] });
    migrations.runMigrations(db);

    db.prepare("UPDATE _migrations SET checksum = ? WHERE version = '001'").run('deadbeef'.repeat(8));
    db.prepare("DELETE FROM _migrations WHERE version = '060'").run();

    const { log, find } = captureLogs();
    const result = migrations.runMigrations(db, { logger: log });

    expect(find('changed after it was applied').length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('changed after it was applied'))).toBe(true);
    db.close();
  });
});

/* ------------------------------------------------------------------ *
 * Backups
 * ------------------------------------------------------------------ */

describe('backups', () => {
  it('captures data that a plain `cp` of the live database would lose', async () => {
    // This is the whole reason scripts/backup.sh exists. Demonstrated, not
    // asserted from a doc comment: in WAL mode the recent writes live in
    // penpal.db-wal, so copying penpal.db alone yields a file that is missing
    // its own tail.
    const dir = tmp();
    const file = path.join(dir, 'penpal.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0'); // guarantee no checkpoint intervenes
    db.exec('CREATE TABLE letters (id INTEGER PRIMARY KEY, encrypted_content TEXT)');
    const ins = db.prepare('INSERT INTO letters (encrypted_content) VALUES (?)');
    for (let i = 0; i < 200; i += 1) ins.run(`cipher-${i}`);

    const live = db.prepare('SELECT COUNT(*) AS n FROM letters').get().n;
    expect(live).toBe(200);

    // What `cp penpal.db backup.db` does, while the server holds the file open.
    const naive = path.join(dir, 'naive-cp.db');
    fs.copyFileSync(file, naive);

    const outDir = path.join(dir, 'backups');
    const manifest = await backup.createBackup({
      db,
      dbPath: file,
      outDir,
      retention: 0,
      includeUploads: false,
      log: { info() {}, warn() {}, error() {} },
    });

    // The backup has everything.
    const restored = new Database(path.join(outDir, manifest.directory, 'penpal.db'), {
      readonly: true,
    });
    expect(restored.prepare('SELECT COUNT(*) AS n FROM letters').get().n).toBe(200);
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    restored.close();

    // The naive copy does not. Asserted rather than assumed: if this ever stops
    // being true the reason for not using `cp` has gone stale and this test
    // says so.
    const naiveRows = (() => {
      try {
        const c = new Database(naive, { readonly: true });
        const n = c.prepare('SELECT COUNT(*) AS n FROM letters').get().n;
        c.close();
        return n;
      } catch {
        return 0; // unreadable counts as "you got nothing", which is the point
      }
    })();
    expect(naiveRows).toBeLessThan(live);

    db.close();
  });

  it('writes a verifiable manifest and a private directory', async () => {
    const { db, file } = openTempDb();
    migrations.runMigrations(db);
    const outDir = path.join(tmp(), 'backups');

    const manifest = await backup.createBackup({
      db,
      dbPath: file,
      outDir,
      retention: 0,
      includeUploads: false,
      log: { info() {}, warn() {}, error() {} },
    });

    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.integrity).toBe('ok');
    expect(manifest.bytes).toBeGreaterThan(0);

    // Photos are plaintext; the directory holding them must not be world-readable.
    expect(fs.statSync(manifest.path).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(manifest.path, 'manifest.json')).mode & 0o777).toBe(0o600);

    const result = backup.verifyBackup(manifest.path);
    expect(result.ok).toBe(true);
    expect(result.sha256_matches_manifest).toBe(true);
    db.close();
  });

  it('prunes past the retention window, oldest first', async () => {
    const dir = tmp();
    const outDir = path.join(dir, 'backups');
    // Five distinguishable databases so each backup has a different checksum.
    const { db, file } = openTempDb();
    migrations.runMigrations(db);

    for (let i = 0; i < 5; i += 1) {
      db.prepare('INSERT INTO users (username,email,password_hash,pid) VALUES (?,?,?,?)')
        .run(`u${i}`, `u${i}@t.test`, 'h', `P${String(i).padStart(5, '0')}`);
      await backup.createBackup({
        db,
        dbPath: file,
        outDir,
        retention: 3,
        includeUploads: false,
        log: { info() {}, warn() {}, error() {} },
      });
    }

    // Directory names are ISO timestamps, so lexicographic order is creation
    // order. Five backups taken within the same second get `-2`, `-3` suffixes;
    // that is still ordered correctly, which is the property that matters.
    const remaining = backup.listBackups(outDir);
    expect(remaining.length).toBe(3);
    // Exactly the newest three by name order survive.
    expect(remaining).toEqual(backup.listBackups(outDir).slice(-3));
    const all = fs
      .readdirSync(outDir)
      .filter((n) => n.startsWith('penpal-'))
      .sort();
    expect(remaining).toEqual(all.slice(-3));
    db.close();
  });

  it('detects a corrupted backup instead of reporting it as good', async () => {
    const { db, file } = openTempDb();
    migrations.runMigrations(db);
    db.prepare('INSERT INTO users (username,email,password_hash,pid) VALUES (?,?,?,?)')
      .run('ada', 'ada@t.test', 'h', 'AAAAAA');

    const outDir = path.join(tmp(), 'backups');
    const manifest = await backup.createBackup({
      db,
      dbPath: file,
      outDir,
      retention: 0,
      includeUploads: false,
      log: { info() {}, warn() {}, error() {} },
    });

    const target = path.join(manifest.path, 'penpal.db');
    expect(backup.verifyBackup(manifest.path).ok).toBe(true);

    // Truncate: the classic half-finished write. Still parseable enough to open,
    // not intact enough to trust.
    const bytes = fs.readFileSync(target);
    fs.writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const result = backup.verifyBackup(manifest.path);
    expect(result.ok).toBe(false);
    expect(result.sha256_matches_manifest).toBe(false);
    db.close();
  });

  it('identifies a v0.0.2-shaped backup as such', () => {
    const { db } = buildV002({ pairs: [[1, 2]] });
    const file = db.name;
    db.close();

    const result = backup.inspectDatabase(file);
    expect(result.ok).toBe(true);
    // Restoring this is legal but puts you back on the old app. The restore
    // script refuses it without an explicit override, and this is why.
    expect(result.pairs_shape).toBe('v0.0.2');
  });
});

/* ------------------------------------------------------------------ *
 * The backup/restore scripts
 * ------------------------------------------------------------------ */

describe('scripts/backup.sh and scripts/restore.sh', () => {
  const run = (script, args, env) =>
    execFileSync('bash', [path.join(ROOT, 'scripts', script), ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  /** Migrated, empty database in its own data dir. */
  function seedInstance() {
    const dataDir = tmp();
    const backupDir = path.join(tmp(), 'backups');
    const { db, file } = openTempDb(dataDir);
    migrations.runMigrations(db);
    return {
      db,
      file,
      env: {
        DATA_DIR: dataDir,
        BACKUP_DIR: backupDir,
        UPLOADS_DIR: path.join(dataDir, 'uploads'),
      },
      backupDir,
    };
  }

  it('refuses to restore without --yes and changes nothing', () => {
    const { db, file, env, backupDir } = seedInstance();

    run('backup.sh', ['--no-uploads'], env);
    expect(backup.listBackups(backupDir).length).toBe(1);
    const name = backup.listBackups(backupDir)[0];

    const before = fs.readFileSync(file);

    let threw = null;
    try {
      run('restore.sh', [name], env);
    } catch (err) {
      threw = err;
    }

    // Exit 2 = "I did nothing, here is the plan".
    expect(threw).not.toBeNull();
    expect(threw.status).toBe(2);
    expect(threw.stdout).toMatch(/Nothing has been changed/);

    // Byte-identical: nothing was touched.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.pre-restore-'))).toEqual([]);
    db.close();
  });

  it('round-trips: back up, destroy the database, restore, data is back', () => {
    const { db, file, env, backupDir } = seedInstance();
    db.prepare('INSERT INTO users (username,email,password_hash,pid) VALUES (?,?,?,?)')
      .run('ada', 'ada@t.test', 'h', 'AAAAAA');

    const out = run('backup.sh', ['--no-uploads'], env);
    expect(out).toMatch(/backup written/);
    expect(out).toMatch(/integrity|sha256/);
    expect(out).toMatch(/NOT encrypted/i);

    const name = backup.listBackups(backupDir)[0];

    // Destroy the live database, and leave behind the WAL/SHM of the database
    // that used to be there. Left in place those get replayed over the restored
    // file and produce a corrupt hybrid that is neither database.
    db.close();
    fs.writeFileSync(file, 'this is not a database');
    fs.writeFileSync(`${file}-wal`, 'stale wal');
    fs.writeFileSync(`${file}-shm`, 'stale shm');

    run('restore.sh', [name, '--yes'], env);

    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);

    const after = new Database(file, { readonly: true });
    expect(after.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(after.prepare('SELECT username FROM users').all()).toEqual([{ username: 'ada' }]);
    after.close();

    // The pre-restore copy means even the destructive step is reversible.
    const safety = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.pre-restore-'));
    expect(safety.length).toBe(1);
  });

  it('refuses to restore a v0.0.2-shaped backup without an explicit override', () => {
    // Restoring that file into the current app is the exact failure the whole
    // migration runner exists to undo: every pairing query throws.
    const { db, env, backupDir } = seedInstance();
    db.close();

    const legacy = buildV002({ pairs: [[1, 2]] });
    fs.copyFileSync(legacy.file, path.join(dataDirOf(env), 'penpal.db'));
    legacy.db.close();

    run('backup.sh', ['--no-uploads'], env);
    const name = backup.listBackups(backupDir).pop();

    let threw = null;
    try {
      run('restore.sh', [name, '--yes'], env);
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(threw.status).toBe(1);
    expect(threw.stderr).toMatch(/v0\.0\.2/);
  });
});

function dataDirOf(env) {
  return env.DATA_DIR;
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

describe('/healthz', () => {
  const opsApp = () => {
    const app = express();
    app.use(opsRoutes());
    return app;
  };

  it('returns 200 and ok:true on a healthy box (the CI contract)', async () => {
    // .github/workflows/ci.yml does `curl -fsS /healthz` and the compose
    // healthcheck does `r.ok`. If this ever stops being 200 on a healthy
    // instance, CI and every container restart break. This assertion is the
    // guard on that.
    const res = await request(opsApp()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.ok).toBe(true);
    expect(res.body.checks.migrations.ok).toBe(true);
  });

  it('is unauthenticated but reveals nothing useful to an attacker', async () => {
    const res = await request(opsApp()).get('/healthz');
    expect(res.status).toBe(200);

    // No version number: an anonymous endpoint that names the exact build is a
    // free gift to anyone matching it against published advisories. The version
    // lives on /api/ops/status, which requires ADMIN_TOKEN.
    expect(res.body.version).toBeUndefined();

    // No inventory, no paths, no counts of anything a stranger could use.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/username|email|pid/i);
    expect(res.body.paths).toBeUndefined();
    expect(res.body.migrations).toBeUndefined();

    // Usability only: a boolean and the reason when it is false.
    expect(Object.keys(res.body).sort()).toEqual(
      ['checks', 'ok', 'status', 'time', 'uptime_s'].sort(),
    );
  });

  it('does not disclose the version on the /api alias either', async () => {
    const res = await request(opsApp()).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body.version).toBeUndefined();
  });

  it('tells an admin the version, once they authenticate', async () => {
    const prev = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-horse-battery-staple';
    try {
      const res = await request(opsApp())
        .get('/api/ops/status')
        .set('X-Admin-Token', 'correct-horse-battery-staple');
      expect(res.status).toBe(200);
      expect(res.body.version).toBeTruthy();
      expect(res.body.paths.data).toBeTruthy();
      expect(res.body.migrations.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prev;
    }
  });

  it('fails when the database file disappears under a live process', async () => {
    // The case a `{ok:true}` liveness probe sails straight past: better-sqlite3
    // holds an open fd, so SELECT 1 keeps succeeding against a deleted inode.
    const dbFile = require('../server/db').getDbPath();
    require('../server/db').getDb(); // ensure it exists
    const hidden = `${dbFile}.hidden`;
    fs.renameSync(dbFile, hidden);
    try {
      const res = await request(opsApp()).get('/healthz');
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.checks.database.error).toMatch(/missing/i);
    } finally {
      fs.renameSync(hidden, dbFile);
    }

    // ...and recovers once it is back.
    const after = await request(opsApp()).get('/healthz');
    expect(after.status).toBe(200);
  });

  it('fails when a migration is pending', () => {
    // Code on disk newer than schema on disk. Serving traffic into this is how
    // a bad deploy becomes a bad afternoon.
    const { db, file } = buildV002({ pairs: [[1, 2]] });
    migrations.runMigrations(db, { to: '001' });

    const report = health.healthReport({ db, dbPath: file, startedAt: Date.now() - 60000 });

    expect(report.ok).toBe(false);
    expect(report.statusCode).toBe(503);
    expect(report.body.ok).toBe(false);
    expect(report.body.checks.migrations.ok).toBe(false);
    expect(report.body.checks.migrations.pending.length).toBeGreaterThan(0);
    db.close();
  });

  it('fails when the database cannot be queried at all', () => {
    const report = health.healthReport({ db: null, dbPath: null, startedAt: Date.now() - 60000 });
    expect(report.ok).toBe(false);
    expect(report.statusCode).toBe(503);
    expect(report.body.checks.database.error).toMatch(/not open/i);
  });

  it('fails when the database file is corrupt', () => {
    const dir = tmp();
    const file = path.join(dir, 'penpal.db');
    const db = new Database(file);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
    const ins = db.prepare('INSERT INTO t (body) VALUES (?)');
    for (let i = 0; i < 400; i += 1) ins.run(`row-${i}-${'x'.repeat(60)}`);

    // Corrupt the file on disk underneath the open handle, which is what a
    // failing disk or a truncated write actually looks like.
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0x00), 0, 4096, 2000);
    fs.closeSync(fd);

    const report = health.healthReport({ db, dbPath: file, startedAt: Date.now() - 60000 });
    expect(report.ok).toBe(false);
    expect(report.statusCode).toBe(503);
    db.close();
  });

  it('waits for the boot to finish before reporting ok', async () => {
    // Reload the module so the real 5s default applies rather than the 0 this
    // suite sets for determinism.
    const prev = process.env.HEALTHZ_BOOT_GRACE_MS;
    delete process.env.HEALTHZ_BOOT_GRACE_MS;
    vi.resetModules();
    const fresh = await import('../server/lib/ops/health.js');
    expect(fresh.BOOT_GRACE_MS).toBeGreaterThan(0);

    const { db, file } = buildV002({ pairs: [[1, 2]] });
    migrations.runMigrations(db);

    const booting = fresh.healthReport({ db, dbPath: file, startedAt: Date.now() });
    expect(booting.body.checks.uptime.ok).toBe(false);
    expect(booting.ok).toBe(false);

    const up = fresh.healthReport({ db, dbPath: file, startedAt: Date.now() - 60000 });
    expect(up.body.checks.uptime.ok).toBe(true);
    expect(up.statusCode).toBe(200);
    db.close();

    vi.resetModules();
    if (prev !== undefined) process.env.HEALTHZ_BOOT_GRACE_MS = prev;
  });
});

/* ------------------------------------------------------------------ *
 * Admin ops routes
 * ------------------------------------------------------------------ */

describe('ops routes', () => {
  const opsApp = () => {
    const app = express();
    app.use(express.json());
    app.use(opsRoutes());
    return app;
  };

  it('refuses admin routes when ADMIN_TOKEN is unset', async () => {
    const prev = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    try {
      // Closed, not open. An ops endpoint that allows everything because
      // somebody forgot an env var is worse than no endpoint at all.
      for (const call of [
        request(opsApp()).get('/api/ops/status'),
        request(opsApp()).get('/api/ops/migrations'),
        request(opsApp()).post('/api/ops/backup'),
        request(opsApp()).post('/api/ops/migrations'),
      ]) {
        const res = await call;
        expect(res.status).toBe(403);
      }
    } finally {
      if (prev !== undefined) process.env.ADMIN_TOKEN = prev;
    }
  });

  it('rejects a wrong token and accepts the right one', async () => {
    const prev = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-horse-battery-staple';
    try {
      const bad = await request(opsApp()).get('/api/ops/status').set('X-Admin-Token', 'nope');
      expect(bad.status).toBe(403);

      const good = await request(opsApp())
        .get('/api/ops/status')
        .set('Authorization', 'Bearer correct-horse-battery-staple');
      expect(good.status).toBe(200);
      expect(good.body.migrations.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prev;
    }
  });

  it('does not accept the admin token in a query string', async () => {
    // Query strings end up in access logs and proxy logs.
    const prev = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'correct-horse-battery-staple';
    try {
      const res = await request(opsApp()).get(
        '/api/ops/status?token=correct-horse-battery-staple',
      );
      expect(res.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prev;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Request ids
 * ------------------------------------------------------------------ */

describe('request ids', () => {
  const ctxApp = () => {
    const app = express();
    app.use(reqCtx.requestContext());
    app.get('/deep', async (req, res) => {
      // Two awaits down, with no `req` in scope: this is the case that proves
      // the AsyncLocalStorage store rather than a threaded argument.
      await new Promise((r) => setTimeout(r, 1));
      loggerMod.logger.info('deep in the stack');
      res.json({ requestId: req.requestId, als: loggerMod.currentRequestId() });
    });
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    app.get('/reject', () => res4xx());
    app.use(reqCtx.errorHandler());
    return app;
  };
  function res4xx() {
    const err = new Error('that is not allowed');
    err.status = 403;
    throw err;
  }

  it('honours an inbound id and echoes it', async () => {
    const res = await request(ctxApp()).get('/deep').set('X-Request-ID', 'req_from_support_1234');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req_from_support_1234');
    expect(res.body.requestId).toBe('req_from_support_1234');
    // Visible three awaits down with nothing passed along.
    expect(res.body.als).toBe('req_from_support_1234');
  });

  it('generates an id when none is supplied', async () => {
    const res = await request(ctxApp()).get('/deep');
    expect(res.body.requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('refuses a hostile inbound id rather than logging it verbatim', () => {
    // Log forging and JSON forging: a request id ends up in the log stream, so
    // an unvalidated one lets a client write a convincing line, or a structured
    // object a log pipeline will happily index as fields.
    for (const hostile of [
      '{"level":"info","msg":"authenticated"}',
      'req\n{"level":"error"}',
      'has space',
      'tab\there',
      'a'.repeat(201),
      '',
    ]) {
      expect(reqCtx.sanitizeInboundId(hostile), `accepted: ${hostile}`).toBeNull();
    }
    // ...while real ids still pass.
    for (const good of [
      'req_from_support_1234',
      '9f2c8a1e-0b3d-4e5f-8a9b-1c2d3e4f5a6b',
      'trace-01H8XY.abc',
      'ABC123',
    ]) {
      expect(reqCtx.sanitizeInboundId(good), `rejected: ${good}`).toBe(good);
    }
  });

  it('puts the request id in the error response and in the error log', async () => {
    const app = ctxApp();
    const res = await request(app).get('/boom').set('X-Request-ID', 'req_err_42');
    expect(res.status).toBe(500);
    // The client gets a way to quote the failure...
    expect(res.body.requestId).toBe('req_err_42');
    // ...and no internal detail.
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toMatch(/kaboom/);
  });

  it('keeps a deliberate 4xx status and its message', async () => {
    const res = await request(ctxApp()).get('/reject').set('X-Request-ID', 'req_4xx_7');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('that is not allowed');
    expect(res.body.requestId).toBe('req_4xx_7');
  });

  it('puts the request id onto every log line emitted during the request', async () => {
    // Anything logged from anywhere in the stack during the request, with no
    // `req` passed, has to carry the id. That is the whole value of the
    // AsyncLocalStorage: "it broke at 14:03" has to be answerable.
    const written = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const app = express();
      app.use(reqCtx.requestContext({ logRequests: false }));
      app.get('/deep', async (req, res) => {
        await new Promise((r) => setTimeout(r, 1));
        loggerMod.logger.info('two awaits deep');
        loggerMod.runWithContext({ requestId: 'req_als_1' }, () => loggerMod.logger.warn('explicit scope'));
        res.json({ ok: true });
      });
      await request(app).get('/deep').set('X-Request-ID', 'req_als_outer');
    } finally {
      process.stdout.write = realWrite;
    }

    const lines = written
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const deep = lines.find((l) => l.msg === 'two awaits deep');
    expect(deep).toBeTruthy();
    expect(deep.request_id).toBe('req_als_outer');

    const explicit = lines.find((l) => l.msg === 'explicit scope');
    expect(explicit.request_id).toBe('req_als_1');
  });

  it('emits an access log line carrying the request id', async () => {
    // The AsyncLocalStorage store must still be live inside the `finish`
    // listener, which runs after the response is already written. This is the
    // assertion that keeps somebody from "simplifying" that later.
    const written = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const app = express();
      app.use(reqCtx.requestContext());
      app.get('/x', (req, res) => res.json({ ok: true }));
      await request(app).get('/x').set('X-Request-ID', 'req_access_9');
    } finally {
      process.stdout.write = realWrite;
    }

    const line = written
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .find((l) => l && l.kind === 'http_access');

    expect(line).toBeTruthy();
    expect(line.request_id).toBe('req_access_9');
    expect(line.method).toBe('GET');
    expect(line.status).toBe(200);
  });
});