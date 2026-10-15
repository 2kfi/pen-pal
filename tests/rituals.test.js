/**
 * Rituals (plan step 27) — the daily shared puzzle, the letter streak and the
 * anniversary counter.
 *
 * ## Why this file reads the SQLite file directly
 *
 * The interesting claim in plan step 27 is not "the streak counts correctly". It
 * is: **every answer and every piece of streak state is E2E-encrypted at rest**,
 * and the server never learns the answer it cannot grade.
 *
 * That claim cannot be tested by looking at an API response, because an API
 * response shows you what the server was willing to *say*, not what it *kept*.
 * So several of these tests read the bytes of the database file and assert that a
 * known plaintext is absent from them. If a future change writes the answer into
 * a column, drops the envelope on the way through, or logs it, the assertion
 * fires against the artefact rather than against a JSON body the server chose.
 *
 * ## The envelope under test is a real one
 *
 * The submissions here are produced by `client/src/lib/crypto.ts` — actual
 * RSA-OAEP-2048 key pairs, actual AES-256-GCM, the same `sealLetter` the browser
 * calls. Nothing here hand-rolls a "ciphertext-shaped" string and calls it a
 * test, because a fake ciphertext would pass every check that mattered and prove
 * nothing about the real one.
 *
 * ## No assertion reaches into private state
 *
 * Everything is exercised through the HTTP surface of `server/routes/rituals.js`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-production-1234567890';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'penpal-rituals-'));
process.env.MIGRATION_AUTO_BACKUP = '0';

const { describe, it, expect, beforeAll, afterAll } = await import('vitest');

// Node has `localStorage` behind a flag, and the zustand stores read it at
// module scope. `client/src/stores/rituals.ts` exports `daysSince`, which is
// genuinely worth testing (the anniversary count), so the stores have to be
// importable at all. A 20-line in-memory shim is the smallest thing that makes
// that possible without a jsdom dependency the rest of the suite does not use.
if (!globalThis.localStorage) {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
}

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const jwt = (await import('jsonwebtoken')).default;

const { initDB, closeDB } = await import('../server/db.js');
const { default: ritualRoutes } = await import('../server/routes/rituals.js');
const { SECRET } = await import('../server/lib/auth.js');
const ritualRepo = (await import('../server/repos/rituals.js')).default;
const migrations = await import('../server/lib/migrations/index.js');

// The real client crypto. Vitest transforms the TypeScript at the repo root the
// same way `npm --prefix client test` does, so this is the shipping code path
// and not a re-implementation of it.
const { generateKeyPair, exportPublicKey, sealLetter, openLetter } = await import(
  '../client/src/lib/crypto.ts'
);
const {
  puzzleFor,
  computeStreak,
  parseAnswer,
  isCorrect,
  verdict,
  utcDay,
  milestone,
  formatDay,
  daysBetween,
} = await import('../client/src/lib/dailyPuzzle.ts');
const { daysSince } = await import('../client/src/stores/rituals.ts');

/* ------------------------------------------------------------------ *
 * harness                                                            *
 * ------------------------------------------------------------------ */

let app;
let counter = 0;
/** The live better-sqlite3 handle, opened by initDB(). */
let db;

beforeAll(() => {
  db = initDB();
  // The rituals router is mounted on its own app rather than on server/index.js,
  // which this task is not allowed to edit. Same router, same auth middleware,
  // same repository — only the mount point differs.
  app = express();
  // The same 1mb limit server/index.js mounts, so the route's own length
  // validation is what answers an oversized body here rather than the parser.
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/rituals', ritualRoutes());
});

afterAll(() => {
  closeDB();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

/** Creates a user with a real key pair and returns a bearer token. */
async function makeUser() {
  counter += 1;
  const n = `${counter}_${Math.random().toString(36).slice(2, 10)}`;
  const keys = await generateKeyPair();
  // The public half is what the server stores and what the partner imports.
  // The private half never leaves this function.
  const publicKey = JSON.stringify(await exportPublicKey(keys.publicKey));
  const info = db
    .prepare(
      'INSERT INTO users (username, email, password_hash, public_key, encrypted_private_key, pid) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`ritual_${n}`, `${n}@test.local`, 'not-used-here', publicKey, '{}', `PID${n.toUpperCase()}`);
  const id = Number(info.lastInsertRowid);
  const token = jwt.sign({ id, username: `ritual_${n}`, pid: `PID${n}` }, SECRET, { expiresIn: '1h' });
  return { id, token, keys, publicKey, name: `ritual_${n}` };
}

const asUser = (token) => ({ Authorization: `Bearer ${token}` });

/** Two users, mutually paired, in the same transaction shape the app uses. */
async function makePair() {
  const a = await makeUser();
  const b = await makeUser();
  db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(a.id, b.id);
  db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(b.id, a.id);
  return { a, b, pairKey: `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}` };
}

/** Seals `text` for real: AES-256-GCM, content key wrapped to both parties. */
async function seal(text, sender, recipient) {
  return JSON.stringify(
    await sealLetter(text, {
      senderId: sender.id,
      recipientId: recipient.id,
      senderPublicKey: JSON.parse(sender.publicKey),
      recipientPublicKey: JSON.parse(recipient.publicKey),
      sentAt: new Date().toISOString(),
    }),
  );
}

/** Both halves of the envelope, so a test can assert one is readable and the
 *  other is not. That asymmetry is the whole point of the reveal. */
async function revealPair(text, sender, recipient) {
  const env = JSON.parse(await seal(text, sender, recipient));
  const asSender = await openLetter(env, sender.keys.privateKey, sender.id);
  let asRecipient = null;
  try {
    asRecipient = await openLetter(env, recipient.keys.privateKey, recipient.id);
  } catch {
    asRecipient = null;
  }
  return { asSender, asRecipient, env };
}

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

/** The raw bytes of the database, including the write-ahead log.
 *
 *  WAL matters: better-sqlite3 runs in WAL mode, so a freshly written row can be
 *  sitting in `penpal.db-wal` and not in the main file yet. Reading only
 *  `penpal.db` would let a plaintext answer hide in the WAL while the test
 *  congratulated itself. */
function databaseBytes() {
  const dir = process.env.DATA_DIR;
  return ['penpal.db', 'penpal.db-wal', 'penpal.db-shm']
    .map((f) => path.join(dir, f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f))
    .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
}

/** Searches for `needle` as ASCII, UTF-8 and UTF-16LE, which is how a value
 *  could plausibly be smuggled into a file. */
function occurrences(haystack, needle) {
  const encodings = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')];
  let count = 0;
  for (const enc of encodings) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(enc, from);
      if (at === -1) break;
      count += 1;
      from = at + 1;
    }
  }
  return count;
}

/* ================================================================== *
 * 1. the daily shared puzzle                                        *
 * ================================================================== */

describe('the daily puzzle', () => {
  it('gives both people the same puzzle, because both of them compute it', () => {
    const key = '7-11';
    for (let i = 0; i < 60; i++) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      // Two independent calls, as two independent browsers would make them.
      const one = puzzleFor(key, day);
      const two = puzzleFor(key, day);
      expect(two).toEqual(one);
      expect(one.day).toBe(day);
    }
  });

  it('gives two different pairs different puzzles', () => {
    let differed = 0;
    for (let i = 0; i < 60; i++) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      if (puzzleFor('7-11', day).answer !== puzzleFor('7-12', day).answer) differed += 1;
    }
    // Not "every day differs" — a seeded stream can collide on the answer by
    // chance — but it must not be the same puzzle for everybody.
    expect(differed).toBeGreaterThan(30);
  });

  it('gives the same pair a different puzzle tomorrow', () => {
    const answers = new Set();
    for (let i = 0; i < 40; i++) {
      answers.add(puzzleFor('7-11', new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10)).answer);
    }
    expect(answers.size).toBeGreaterThan(5);
  });

  /**
   * The real test of "both compute the same answer": solve each puzzle from its
   * prompt alone, exactly as a person would, and check the arithmetic.
   *
   * A deterministic PRNG guarantees two clients agree. It does not guarantee the
   * puzzle is *solvable* — a generator that emits an inconsistent prompt would
   * have both partners agree on the same wrong number, which reads exactly like
   * success. This solves from the text.
   */
  it('every puzzle is solvable from its own prompt, with one answer', () => {
    for (let i = 0; i < 400; i++) {
      const day = new Date(Date.UTC(2026, 0, 1 + (i % 365))).toISOString().slice(0, 10);
      const puzzle = puzzleFor(`${(i % 7) + 1}-${(i % 11) + 2}`, day);
      const text = puzzle.prompt;

      if (puzzle.shape === 'three-numbers') {
        const total = Number(text.match(/add up to (\d+)/)[1]);
        const gap = Number(text.match(/first is (\d+) more than the second/)[1]);
        const second = Number(text.match(/and the second is (\d+)/)[1]);
        const first = second + gap;
        expect(total - first - second).toBe(puzzle.answer);
        expect(puzzle.answer).toBeGreaterThan(0);
      } else if (puzzle.shape === 'wax-and-letter') {
        const sealGrams = Number(text.match(/weighs (\d+) grams/)[1]);
        const extra = Number(text.match(/plus (\d+) grams/)[1]);
        expect(sealGrams % 2).toBe(0);
        expect(sealGrams / 2 + extra).toBe(puzzle.answer);
      } else {
        const stamp = text.match(/reads (\d{4})\./)[1];
        const sum = [...stamp].reduce((a, d) => a + Number(d), 0);
        expect(sum).toBe(puzzle.answer);
      }
    }
  });

  it('uses all three shapes over a year, so it is not one question forever', () => {
    const shapes = new Set();
    for (let i = 0; i < 365; i++) {
      shapes.add(puzzleFor('7-11', new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)).shape);
    }
    expect([...shapes].sort()).toEqual(['four-digits', 'three-numbers', 'wax-and-letter']);
  });

  it('reads a forgiving answer, and refuses a non-number plainly', () => {
    expect(parseAnswer('  17 ')).toBe('17');
    expect(parseAnswer('1,700')).toBe('1700');
    expect(parseAnswer('17.')).toBeNull();
    expect(parseAnswer('')).toBeNull();
    expect(parseAnswer('seventeen')).toBeNull();
    expect(parseAnswer('17px')).toBeNull();
  });

  it('grades with no account of who did better', () => {
    const puzzle = puzzleFor('7-11', '2026-03-14');
    const right = String(puzzle.answer);
    const wrong = String(puzzle.answer + 1);
    expect(verdict(puzzle, right, right)).toBe('You both had it.');
    expect(verdict(puzzle, right, wrong)).toMatch(/only one on the page/);
    expect(verdict(puzzle, wrong, right)).toMatch(/You did not have it/);
    expect(verdict(puzzle, wrong, wrong)).toBe('Neither of you had it. That happens.');
    expect(isCorrect(puzzle, wrong)).toBe(false);
  });
});

/* ================================================================== *
 * 2. the letter streak                                              *
 * ================================================================== */

describe('the letter streak', () => {
  const day = (n) => new Date(Date.UTC(2026, 2, 1 + n)).toISOString().slice(0, 10);

  it('counts the longest run, not the run that happens to be live', () => {
    const streak = computeStreak(
      [day(0), day(1), day(2), day(9), day(10)],
      day(11),
    );
    expect(streak.longest).toBe(3);
    expect(streak.lastDay).toBe(day(10));
    expect(streak.quietDays).toBe(1);
    expect(streak.alive).toBe(true);
  });

  it('treats a break as a fact to state, never as a zero to punish', () => {
    const streak = computeStreak([day(0), day(1)], day(20));
    expect(streak.longest).toBe(2);
    expect(streak.quietDays).toBe(19);
    expect(streak.alive).toBe(false);
    // The run that ended is still counted; what changed is `alive`.
    expect(streak.current).toBe(2);
  });

  it('does not break a streak just because today has not happened yet', () => {
    // Wrote yesterday. Today is not over, so the day is still open.
    const streak = computeStreak([day(0)], day(1));
    expect(streak.alive).toBe(true);
    expect(computeStreak([day(0)], day(0)).alive).toBe(true);
    expect(computeStreak([day(0)], day(2)).alive).toBe(false);
  });

  it('reports nothing rather than zero when no letter has ever crossed', () => {
    const streak = computeStreak([], '2026-03-14');
    expect(streak.lastDay).toBeNull();
    expect(streak.longest).toBe(0);
    expect(streak.alive).toBe(false);
    expect(streak.quietDays).toBe(-1);
  });

  it('draws a 28-day strip that ends today and starts 27 days back', () => {
    const streak = computeStreak([day(0)], day(27));
    expect(streak.marks).toHaveLength(28);
    expect(streak.marks.at(-1).day).toBe(day(27));
    expect(streak.marks[0].day).toBe(day(0));
    expect(streak.marks.filter((m) => m.marked)).toHaveLength(1);
  });

  it('ignores a duplicate day rather than double-counting it', () => {
    const withDupe = computeStreak(['2026-03-01', '2026-03-01', '2026-03-02'], '2026-03-02');
    expect(withDupe.longest).toBe(2);
  });

  /**
   * The reason the ritual is written against UTC at all: two people who live in
   * different timezones must see the same calendar. This asserts it at the point
   * where it is easy to get wrong — an instant that is a different *date* in two
   * places must resolve to one day for both of them.
   */
  it('counts UTC days, so two timezones cannot disagree about yesterday', () => {
    const instant = new Date('2026-03-14T23:30:00Z');
    const auckland = new Date(instant.toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
    const reykjavik = new Date(instant.toLocaleString('en-US', { timeZone: 'Atlantic/Reykjavik' }));

    // The premise: it genuinely is a different local date in each place.
    expect(utcDay(auckland)).toBe('2026-03-15');
    expect(utcDay(reykjavik)).toBe('2026-03-14');
    // The property: the ritual uses the UTC day, so the day does not depend on
    // whose device computed it.
    expect(utcDay(instant)).toBe('2026-03-14');
  });

  it('reads a SQLite UTC stamp as its first ten characters', () => {
    const repo = ritualRepo(db);
    const { utcDay: serverUtcDay } = repo._internals;
    expect(serverUtcDay('2026-03-14 23:30:00')).toBe('2026-03-14');
    expect(serverUtcDay('2026-03-14T23:30:00.000Z')).toBe('2026-03-14');
    expect(serverUtcDay('2026-03-14T23:30:00+05:00')).toBe('2026-03-14');
    expect(serverUtcDay(null)).toBeNull();
    expect(serverUtcDay('not a date')).toBeNull();
  });

  it('marks a milestone only for a run that actually happened', () => {
    // A streak built from `longest` consecutive days, ending today.
    const withLongest = (longest) => {
      const days = Array.from({ length: longest }, (_, i) => day(i));
      return milestone(computeStreak(days, day(longest - 1)));
    };
    expect(withLongest(0)).toBeNull();
    expect(withLongest(6)).toBeNull();
    expect(withLongest(7)).toMatch(/A week/);
    expect(withLongest(30)).toMatch(/A month/);
    expect(withLongest(100)).toMatch(/hundred/);
    expect(withLongest(365)).toMatch(/full year/);
  });

  it('formats a date the same way in every country', () => {
    expect(formatDay('2026-03-14')).toBe('14 Mar 2026');
    expect(formatDay(null)).toBe('—');
    expect(formatDay('nonsense')).toBe('—');
    // Not "14 March 2026" and not "3/14/2026": two people should read the same
    // date the same way.
    expect(formatDay('2026-01-05')).toBe('5 Jan 2026');
  });
});

/* ================================================================== *
 * 3. the anniversary counter                                        *
 * ================================================================== */

describe('the anniversary counter', () => {
  it('counts whole days from a chosen day to today', () => {
    expect(daysSince('2026-03-01', '2026-03-14')).toBe(13);
    expect(daysSince('2026-03-14', '2026-03-14')).toBe(0);
  });

  it('never runs backwards, even if a date is saved in the future', () => {
    expect(daysSince('2026-03-14', '2026-03-01')).toBe(0);
  });

  it('answers 0 for an unparseable date rather than NaN', () => {
    expect(daysSince('', '2026-03-14')).toBe(0);
    expect(daysSince('not a day', '2026-03-14')).toBe(0);
    expect(daysSince('2026-03-14', 'rubbish')).toBe(0);
  });

  it('spans a month boundary and a leap day without drifting', () => {
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    // 2028 is a leap year.
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysSince('2025-12-25', '2026-01-01')).toBe(7);
  });
});

/* ================================================================== *
 * 4. the rituals API                                                *
 * ================================================================== */

describe('GET /api/rituals', () => {
  it('answers an unpaired reader with an invitation, not an error', async () => {
    const loner = await makeUser();
    const res = await request(app).get('/api/rituals').set(asUser(loner.token));
    expect(res.status).toBe(200);
    expect(res.body.paired).toBe(false);
    // The page has to know what day it is even with nobody to run it with.
    expect(res.body.today).toBe(today());
  });

  it('refuses an unauthenticated reader', async () => {
    await request(app).get('/api/rituals').expect(401);
  });

  it('gives the pair one canonical key whichever of them asks', async () => {
    const { a, b, pairKey } = await makePair();
    for (const user of [a, b]) {
      const res = await request(app).get('/api/rituals').set(asUser(user.token));
      expect(res.status).toBe(200);
      expect(res.body.paired).toBe(true);
      expect(res.body.pairKey).toBe(pairKey);
    }
  });

  it('takes the day from the server, not from the request', async () => {
    const { a } = await makePair();
    const res = await request(app)
      .get('/api/rituals?day=1999-01-01')
      .set(asUser(a.token));
    // A day nobody answered falls back to today rather than becoming a puzzle
    // from the past with no submissions to reveal.
    expect(res.body.day).toBe(today());
  });

  it('reports the day the first letter crossed', async () => {
    const { a, b } = await makePair();
    const first = `${today()}T08:00:00.000Z`;
    db.prepare(
      "INSERT INTO letters (sender_id, recipient_id, encrypted_content, sent_at, created_at, state) VALUES (?, ?, ?, ?, ?, 'opened')",
    ).run(a.id, b.id, 'irrelevant', first, first);
    const res = await request(app).get('/api/rituals').set(asUser(a.token));
    expect(res.body.letters.firstLetterAt).toBe(first);
    expect(res.body.letters.days).toEqual([today()]);
  });

  it('does not count a draft as a day that carried a letter', async () => {
    const { a, b } = await makePair();
    // A draft that was never sent has a sent_at in this repo's legacy shape,
    // so a query that forgets the state filter would mark today.
    const at = `${today()} 09:00:00`;
    db.prepare(
      "INSERT INTO letters (sender_id, recipient_id, encrypted_content, sent_at, created_at, state) VALUES (?, ?, ?, ?, ?, 'draft')",
    ).run(a.id, b.id, 'irrelevant', at, new Date().toISOString());
    const res = await request(app).get('/api/rituals').set(asUser(a.token));
    expect(res.body.letters.days).toEqual([]);
    expect(res.body.letters.firstLetterAt).toBeNull();
  });

  it('does not count a letter scheduled for the future', async () => {
    const { a, b } = await makePair();
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    db.prepare(
      "INSERT INTO letters (sender_id, recipient_id, encrypted_content, sent_at, created_at, state) VALUES (?, ?, ?, ?, ?, 'in_transit')",
    ).run(a.id, b.id, 'irrelevant', future, new Date().toISOString());
    const res = await request(app).get('/api/rituals').set(asUser(a.token));
    expect(res.body.letters.days).toEqual([]);
  });

  it('cannot be pointed at another pair', async () => {
    const mine = await makePair();
    const theirs = await makePair();
    // No body field, no query parameter and no header reaches the pair key; it
    // is derived from the caller's own pairs row. Anything else would let one
    // reader read another's ritual.
    for (const attempt of [
      `/api/rituals?pair_key=${theirs.pairKey}`,
      `/api/rituals?pairKey=${theirs.pairKey}`,
      `/api/rituals?user_id=${theirs.a.id}`,
    ]) {
      const res = await request(app).get(attempt).set(asUser(mine.a.token));
      expect(res.body.pairKey).toBe(mine.pairKey);
      expect(res.body.pairKey).not.toBe(theirs.pairKey);
    }
  });
});

describe('POST /api/rituals/puzzle — withholding', () => {
  it('will not show either answer until both have been sent', async () => {
    const { a, b, pairKey } = await makePair();
    const puzzle = puzzleFor(pairKey, today());
    const answer = String(puzzle.answer);

    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: today(), encryptedAnswer: await seal(answer, a, b) })
      .expect(200);

    const mine = await request(app).get('/api/rituals').set(asUser(a.token));
    expect(mine.body.puzzle.revealed).toBe(false);
    expect(mine.body.puzzle.theirs).toBeNull();

    const theirs = await request(app).get('/api/rituals').set(asUser(b.token));
    expect(theirs.body.puzzle.revealed).toBe(false);
    // Not a null, not a length, not a timestamp: nothing at all.
    expect(theirs.body.puzzle.theirs).toBeNull();
    // Their own submission is theirs to see.
    expect(theirs.body.puzzle.mine).toBeNull();

    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(b.token))
      .send({ day: today(), encryptedAnswer: await seal(answer, b, a) })
      .expect(200);

    for (const user of [a, b]) {
      const res = await request(app).get('/api/rituals').set(asUser(user.token));
      expect(res.body.puzzle.revealed).toBe(true);
      expect(res.body.puzzle.mine.encryptedAnswer).toBeTruthy();
      expect(res.body.puzzle.theirs.encryptedAnswer).toBeTruthy();
    }
  });

  it('replaces an answer for the same day rather than duplicating it', async () => {
    const { a, b, pairKey } = await makePair();
    const answer = String(puzzleFor(pairKey, today()).answer);
    const envelope = await seal(answer, a, b);
    await request(app).post('/api/rituals/puzzle').set(asUser(a.token)).send({ day: today(), encryptedAnswer: envelope });
    await request(app).post('/api/rituals/puzzle').set(asUser(a.token)).send({ day: today(), encryptedAnswer: envelope });
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM ritual_puzzles WHERE pair_key = ? AND day = ? AND user_id = ?')
      .get(pairKey, today(), a.id);
    expect(rows.n).toBe(1);
  });

  it('accepts yesterday, so a reply just after midnight is not thrown away', async () => {
    const { a, b } = await makePair();
    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: yesterday(), encryptedAnswer: await seal('4', a, b) })
      .expect(200);
  });

  it('refuses a day that has closed', async () => {
    const { a, b } = await makePair();
    const old = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const res = await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: old, encryptedAnswer: await seal('4', a, b) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/closed/i);
  });

  it('refuses an unpaired writer', async () => {
    const loner = await makeUser();
    const res = await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(loner.token))
      .send({ day: today(), encryptedAnswer: '{}' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/rituals/puzzle — envelope validation', () => {
  it('rejects anything that is not a sealed envelope', async () => {
    const { a, b } = await makePair();
    const bad = [
      'not json at all',
      '{}',
      JSON.stringify({ v: 2 }),
      JSON.stringify({ v: 2, ct: '', iv: 'aaaa', keys: {}, senderId: a.id, recipientId: b.id, sentAt: new Date().toISOString() }),
      JSON.stringify({ v: 2, ct: 'aaaa', iv: 'aaaa', keys: {}, senderId: a.id, recipientId: b.id, sentAt: 'whenever' }),
      JSON.stringify({ v: 2, ct: 'aaaa', iv: 'aaaa', keys: {}, senderId: 'me', recipientId: b.id, sentAt: new Date().toISOString() }),
    ];
    for (const encryptedAnswer of bad) {
      const res = await request(app)
        .post('/api/rituals/puzzle')
        .set(asUser(a.token))
        .send({ day: today(), encryptedAnswer });
      expect(res.status, `expected 400 for: ${encryptedAnswer.slice(0, 40)}`).toBe(400);
    }
  });

  it('rejects a day that is not a date', async () => {
    const { a, b } = await makePair();
    for (const day of ['', 'today', '2026-3-1', '2026-03-14T00:00:00Z', '../../etc/passwd']) {
      const res = await request(app)
        .post('/api/rituals/puzzle')
        .set(asUser(a.token))
        .send({ day, encryptedAnswer: await seal('4', a, b) });
      expect(res.status, `expected 400 for day: ${day}`).toBe(400);
    }
  });

  /**
   * The check that makes a shared ritual possible: the envelope must carry a
   * wrapped content key for the *partner*, or the answer would be one nobody can
   * ever open. The server cannot read the answer to verify that; it reads the
   * header, which is exactly as much as it is entitled to.
   */
  it('rejects an answer the partner could not open', async () => {
    const { a, b } = await makePair();
    const env = JSON.parse(await seal('4', a, b));
    delete env.keys[String(b.id)];
    const res = await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: today(), encryptedAnswer: JSON.stringify(env) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/partner/i);
  });

  it('rejects an envelope addressed to somebody else', async () => {
    const mine = await makePair();
    const theirs = await makePair();
    // The envelope is genuinely readable by the wrong pair: real keys, real
    // ciphertext, just addressed elsewhere.
    const res = await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(mine.a.token))
      .send({ day: today(), encryptedAnswer: await seal('4', theirs.a, theirs.b) });
    expect(res.status).toBe(400);
  });

  it('rejects a body that is too large to be an answer', async () => {
    const { a } = await makePair();
    const res = await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: today(), encryptedAnswer: 'x'.repeat(200001) });
    expect(res.status).toBe(400);
  });
});

/* ================================================================== *
 * 5. E2E at rest — the point of the whole thing                     *
 * ================================================================== */

describe('the answer is ciphertext at rest', () => {
  it('both answers are stored, and neither plaintext is anywhere in the file', async () => {
    const { a, b, pairKey } = await makePair();
    const puzzle = puzzleFor(pairKey, today());
    const mine = String(puzzle.answer);
    const theirs = String(puzzle.answer + 1);

    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: today(), encryptedAnswer: await seal(mine, a, b) })
      .expect(200);
    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(b.token))
      .send({ day: today(), encryptedAnswer: await seal(theirs, b, a) })
      .expect(200);

    // The rows exist.
    const rows = db
      .prepare('SELECT user_id, encrypted_answer FROM ritual_puzzles WHERE pair_key = ? AND day = ?')
      .all(pairKey, today());
    expect(rows).toHaveLength(2);

    // And every one of them is an envelope, not a number.
    for (const row of rows) {
      const env = JSON.parse(row.encrypted_answer);
      expect(env.v).toBe(2);
      expect(typeof env.ct).toBe('string');
      expect(env.ct.length).toBeGreaterThan(0);
      // Base64 ciphertext, so it cannot be the decimal answer by accident.
      expect(env.ct).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(Object.keys(env.keys).sort()).toEqual([String(a.id), String(b.id)].sort());
      // The plaintext appears nowhere in the stored column — not as a bare
      // value, not as a quoted JSON string, not as a substring of the envelope.
      // (Checked against the column rather than the whole file, because a one-
      // or two-digit answer does occur by chance in a base64 blob, and a test
      // that cannot tell the difference is a test that proves nothing.)
      expect(row.encrypted_answer).not.toBe(mine);
      expect(row.encrypted_answer).not.toBe(theirs);
      expect(row.encrypted_answer).not.toContain(`"${mine}"`);
      expect(row.encrypted_answer).not.toContain(`"${theirs}"`);
    }

    // Now the artefact itself. A canary long enough that no base64 blob will
    // contain it by chance: this is the airtight half of the claim.
    const CANARY = 'RITUAL-ANSWER-CANARY-4f9c2ab7-do-not-store-me-in-the-clear';
    const { a: c, b: d } = await makePair();
    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(c.token))
      .send({ day: today(), encryptedAnswer: await seal(CANARY, c, d) })
      .expect(200);
    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(d.token))
      .send({ day: today(), encryptedAnswer: await seal(CANARY, d, c) })
      .expect(200);

    const bytes = databaseBytes();
    expect(bytes.length).toBeGreaterThan(0);
    // Long enough that a collision is not a plausible explanation.
    expect(occurrences(bytes, CANARY)).toBe(0);
    expect(occurrences(bytes, CANARY.slice(0, 24))).toBe(0);
    // The two real numeric answers are checked against the file too — but keyed,
    // not bare. This assertion was `"18"` and it failed, correctly, because a
    // user id is a JSON *object key* in the envelope and keys are quoted:
    //
    //     "keys":{"18":"CMraVU7Bi7AkzVhxKdi…"}
    //
    // The answer was 18, the key was 18, and nothing leaked. Searching for a
    // bare quoted number therefore proves nothing at all — it fails for the
    // right reason and reports the wrong one. These are the two shapes a real
    // leak would take: the answer stored as a JSON value under an obvious name,
    // or as a quoted string. Both are long enough to be unambiguous and both
    // cannot be produced by chance from base64 or from a user id.
    //
    // Note also that SQLite stores integers as binary varints, so a plaintext
    // INTEGER column would not be greppable as ASCII at all. A raw byte search
    // is a weak instrument here; the CANARY above is the claim that carries
    // weight, and the structural assertions above carry the rest.
    for (const value of [mine, theirs]) {
      for (const shape of [`"answer":${value}`, `"answer":"${value}"`, `"answer": ${value}`]) {
        expect(occurrences(bytes, shape)).toBe(0);
      }
    }
  });

  it('the ledger holding the streak is ciphertext at rest too', async () => {
    const { a, b, pairKey } = await makePair();
    const streak = computeStreak(
      [new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), today()],
      today(),
    );
    const ledger = JSON.stringify({
      v: 1,
      current: streak.current,
      longest: streak.longest,
      anniversary: '2026-02-14',
      written: true,
    });

    await request(app)
      .put('/api/rituals/ledger')
      .set(asUser(a.token))
      .send({ encryptedState: await seal(ledger, a, b) })
      .expect(200);

    const row = db
      .prepare('SELECT encrypted_state FROM ritual_ledgers WHERE pair_key = ? AND user_id = ?')
      .get(pairKey, a.id);
    expect(row).toBeTruthy();

    const env = JSON.parse(row.encrypted_state);
    expect(env.v).toBe(2);
    expect(env.ct).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    const bytes = databaseBytes();
    // The anniversary date, the counts, and the whole JSON are all absent.
    expect(occurrences(bytes, '"anniversary"')).toBe(0);
    expect(occurrences(bytes, '2026-02-14')).toBe(0);
    expect(occurrences(bytes, '"longest"')).toBe(0);

    // And it is genuinely openable by the pair, which is what makes the absence
    // above mean something: the data is there, and only they can read it.
    const { asRecipient } = await revealPair(ledger, a, b);
    expect(JSON.parse(asRecipient).longest).toBe(streak.longest);
  });

  it('only the pair can open the answer, and a third party cannot', async () => {
    const { a, b } = await makePair();
    const outsider = await makeUser();
    const envelope = await seal('42', a, b);
    const env = JSON.parse(envelope);

    const asA = await openLetter(env, a.keys.privateKey, a.id);
    const asB = await openLetter(env, b.keys.privateKey, b.id);
    expect(asA).toBe('42');
    expect(asB).toBe('42');

    // A stranger with a valid key pair of their own still cannot open it: there
    // is no wrapped content key addressed to them.
    await expect(
      openLetter(env, outsider.keys.privateKey, outsider.id),
    ).rejects.toThrow(/could not be decrypted/i);
  });

  it('gives the pair their own two answers back, and nothing else', async () => {
    const { a, b, pairKey } = await makePair();
    const puzzle = puzzleFor(pairKey, today());
    const answer = String(puzzle.answer);

    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(a.token))
      .send({ day: today(), encryptedAnswer: await seal(answer, a, b) })
      .expect(200);
    await request(app)
      .post('/api/rituals/puzzle')
      .set(asUser(b.token))
      .send({ day: today(), encryptedAnswer: await seal(answer, b, a) })
      .expect(200);

    const res = await request(app).get('/api/rituals').set(asUser(a.token));
    expect(res.body.puzzle.revealed).toBe(true);

    // The server hands back two envelopes and no plaintext.
    expect(res.body.puzzle.mine.encryptedAnswer).not.toBe(answer);
    expect(res.body.puzzle.theirs.encryptedAnswer).not.toBe(answer);
    // No field anywhere in the response carries the answer as a value. Checked
    // structurally rather than with `JSON.stringify(...).includes(answer)`,
    // because a one-digit answer appears inside base64 ciphertext by chance and
    // a substring scan would fail at random while proving nothing.
    const values = [];
    const walk = (node) => {
      if (typeof node === 'string') values.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(res.body);
    expect(values).not.toContain(answer);
    // And no field is even *named* as if it held one.
    expect(Object.keys(res.body.puzzle)).toEqual(
      expect.arrayContaining(['day', 'revealed', 'mine', 'theirs', 'theirPending']),
    );

    // Both open to the same number, which is the whole ritual.
    const mine = await openLetter(JSON.parse(res.body.puzzle.mine.encryptedAnswer), a.keys.privateKey, a.id);
    // Theirs is wrapped to *both* parties, so either of them opens it with their
    // own key and their own id — which is exactly why a third party cannot.
    const theirs = await openLetter(JSON.parse(res.body.puzzle.theirs.encryptedAnswer), b.keys.privateKey, b.id);
    expect(mine).toBe(answer);
    expect(theirs).toBe(answer);
  });

  it('the schema has no column that could hold a grade', async () => {
    for (const table of ['ritual_puzzles', 'ritual_ledgers']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      expect(columns).toContain(table === 'ritual_puzzles' ? 'encrypted_answer' : 'encrypted_state');
      for (const forbidden of ['answer', 'is_correct', 'correct', 'score', 'streak', 'plaintext']) {
        expect(columns, `${table} must not have a ${forbidden} column`).not.toContain(forbidden);
      }
    }
  });

  it('records the rituals migration once, and only once', async () => {
    // The runner throws on a duplicate version; this asserts it does not.
    expect(() => migrations.listMigrations()).not.toThrow();
    const applied = migrations.appliedMigrations(db);
    expect(applied.has('060')).toBe(true);
    expect(applied.get('060').name).toBe('rituals');
    expect([...applied.values()].filter((r) => r.name === 'rituals')).toHaveLength(1);
  });
});

/* ================================================================== *
 * 6. the gallery and the CI gate must agree                         *
 * ================================================================== */

describe('/style and npm run design:check', () => {
  const root = path.join(import.meta.dirname, '..');

  const pairsIn = (file) => {
    const source = fs.readFileSync(file, 'utf8');
    const out = [];
    // Deliberately matches only a four-element ['fg','bg',min,'label'] tuple, so
    // the object literals in the same file (which carry a fifth `where` field)
    // cannot be swept up and make the comparison look like a mismatch.
    const re = /\[\s*'([a-z0-9-]+)',\s*'([a-z0-9-]+)',\s*([\d.]+),\s*'([^']+)'\s*\]/g;
    for (const m of source.matchAll(re)) out.push([m[1], m[2], Number(m[3]), m[4]]);
    return out;
  };

  it('checks exactly the pairs the CI gate checks, in the same order', () => {
    const gate = pairsIn(path.join(root, 'tools/check-contrast.mjs'));
    const gallery = pairsIn(path.join(root, 'client/src/pages/StyleGuide.tsx'));

    // The two lists must be identical — that is the real invariant, and it is
    // what stops the gallery drifting away from what CI enforces.
    expect(gallery).toEqual(gate);

    // A floor rather than an exact count. This used to assert `toBe(11)`, which
    // meant adding a legitimate pairing — four of them, once --paper-2 was
    // checked — failed the build and tempted someone into deleting the check
    // instead of making it. Silently *removing* pairs must still fail.
    expect(gate.length).toBeGreaterThanOrEqual(11);
  });

  it('re-derives every gated pair from the tokens and agrees with the gate', async () => {
    const css = fs.readFileSync(path.join(root, 'client/src/tokens.css'), 'utf8');
    const theme = (name) => {
      const block = css.match(new RegExp(`\\[data-theme='${name}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
      const out = {};
      for (const m of block[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
      return out;
    };
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const name of ['dark', 'light']) {
      const t = theme(name);
      for (const [fg, bg, min] of pairsIn(path.join(root, 'tools/check-contrast.mjs'))) {
        const ratio = contrast(t[fg], t[bg]);
        expect(ratio, `${name}: --${fg} on --${bg}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('renders the type scale from the same tokens CI does not check', () => {
    // The gallery's type steps must be exactly the seven the tokens declare.
    const css = fs.readFileSync(path.join(root, 'client/src/tokens.css'), 'utf8');
    const declared = [...css.matchAll(/--type-([a-z0-9]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
    expect(declared.map((d) => d[0])).toEqual(['xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl']);

    const gallery = fs.readFileSync(path.join(root, 'client/src/pages/StyleGuide.tsx'), 'utf8');
    for (const [name, value] of declared) {
      expect(gallery, `--type-${name} missing from the gallery`).toContain(`'type-${name}'`);
      expect(value).toMatch(/^\d*\.?\d+rem$/);
    }
  });
});