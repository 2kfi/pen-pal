/**
 * The day's shared puzzle (plan step 27).
 *
 * Both people get the same puzzle on the same day because both of them *compute*
 * it. There is no server-side puzzle of the day: given a pair key and a UTC day
 * this module produces the identical puzzle in both browsers, on both sides of
 * the planet, with no network round-trip and nothing for the server to leak.
 *
 * The properties that follow from that, and which are the reason for the design:
 *
 *   - The server cannot grade. It does not have the answer and has no vocabulary
 *     for one, so a compromise of the database reveals *that* two people shared
 *     an answer and nothing about what either of them wrote.
 *   - Neither person can see the other's answer until both have submitted. The
 *     server withholds the envelope until both rows exist, and neither client
 *     ever holds the other's envelope before that.
 *   - The answers are sealed with the same envelope as a letter, so the SQLite
 *     file holds ciphertext for all of it.
 *
 * Being honest about the limit: a puzzle derived deterministically in the
 * browser can be read by its own solver in devtools. That is unavoidable and it
 * is not what this protects. What this protects is that *the server* never
 * learns the answer and that neither partner sees the other's answer first.
 *
 * The PRNG is deliberately tiny and boring — FNV-1a into mulberry32 — because a
 * bespoke hash is a bespoke way to be wrong. Same string in, same puzzle out,
 * on every browser, forever: changing this module changes every past puzzle.
 */

/** A fixed namespace so the day key is never a bare pair id. */
const NAMESPACE = 'penpal:daily-puzzle:v1';

/* ------------------------------------------------------------------ *
 * seeded randomness                                                    *
 * ------------------------------------------------------------------ */

/** FNV-1a, 32-bit. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: 32-bit state, uniform output, identical everywhere. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An independent stream per question, so one question cannot shift another. */
function streamFor(pairKey: string, day: string, channel: string): () => number {
  return mulberry32(fnv1a(`${NAMESPACE}:${pairKey}:${day}:${channel}`));
}

/* ------------------------------------------------------------------ *
 * days                                                                 *
 * ------------------------------------------------------------------ */

/**
 * The puzzle's clock is the UTC day, for both of you.
 *
 * That is a deliberate choice over "your local day": two people in different
 * timezones would otherwise be answering different puzzles and never seeing the
 * same reveal. A UTC day is the only clock they genuinely share. One in
 * Reykjavik and one in Auckland get the same puzzle; one of them sees it in the
 * morning and the other in the evening.
 */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days between two UTC days, never negative. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/* ------------------------------------------------------------------ *
 * the puzzle                                                           *
 * ------------------------------------------------------------------ */

export type PuzzleShape = 'three-numbers' | 'wax-and-letter' | 'four-digits';

export interface Puzzle {
  /** UTC day this puzzle belongs to. */
  day: string;
  shape: PuzzleShape;
  /** The question, in plain words. Shown as written. */
  prompt: string;
  /** One more line of context. Never a label — a sentence. */
  note: string;
  /** The number, computed locally. Never sent anywhere. */
  answer: number;
}

/**
 * Three shapes, picked by the day, so the ritual does not become one repeated
 * question forever. Each has exactly one answer and none of them needs a
 * wordlist — which matters, because a puzzle whose answer sits in a table
 * shipped to the client is a table the server can hold too.
 */
export function puzzleFor(pairKey: string, day: string): Puzzle {
  const pick = streamFor(pairKey, day, 'shape')();
  const shape: PuzzleShape =
    pick < 1 / 3 ? 'three-numbers' : pick < 2 / 3 ? 'wax-and-letter' : 'four-digits';

  if (shape === 'three-numbers') {
    // second is known; first is a known gap more than second; third is hidden.
    // "first + second + third = total" therefore has exactly one solution.
    const rand = streamFor(pairKey, day, 'numbers');
    const second = 4 + Math.floor(rand() * 12); // 4..15
    const gap = 3 + Math.floor(rand() * 8); // 3..10
    const first = second + gap;
    const third = 2 + Math.floor(rand() * 20); // 2..21
    const total = first + second + third;
    return {
      day,
      shape,
      prompt: `Three numbers add up to ${total}. The first is ${gap} more than the second, and the second is ${second}. What is the third?`,
      note: 'One of the three is missing. The other two are stated.',
      answer: third,
    };
  }

  if (shape === 'wax-and-letter') {
    // A seal that weighs an even number of grams, so half of it is whole.
    const rand = streamFor(pairKey, day, 'grams');
    const half = 2 + Math.floor(rand() * 11); // 2..12
    const seal = half * 2; // 4..24
    const extra = 1 + Math.floor(rand() * 9); // 1..9
    return {
      day,
      shape,
      prompt: `A wax seal weighs ${seal} grams. A letter weighs half of one seal, plus ${extra} grams. How many grams does a letter weigh?`,
      note: 'Half of the seal first, then the extra.',
      answer: half + extra,
    };
  }

  const rand = streamFor(pairKey, day, 'stamp');
  // 1000..9999, so the number always reads as four digits and never has a
  // leading zero to explain away.
  const stamp = 1000 + Math.floor(rand() * 9000);
  let answer = 0;
  for (const ch of String(stamp)) answer += Number(ch);
  return {
    day,
    shape,
    prompt: `Today's postmark reads ${stamp}. What do its four digits add up to?`,
    note: 'Add the digits in the order they are printed.',
    answer,
  };
}

/* ------------------------------------------------------------------ *
 * answering                                                            *
 * ------------------------------------------------------------------ */

/**
 * Reads whatever someone typed and gives back the number it means, or null.
 *
 * Written in the interface's voice rather than the engineer's: "17", "17.", " 17 "
 * and "1,700" for a puzzle whose answer is 17 all mean 17, and a person
 * answering on a phone should not be punished for a stray space.
 */
export function parseAnswer(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s,]/g, '');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? String(value) : null;
}

export function isCorrect(puzzle: Puzzle, given: string | null): boolean {
  return given !== null && Number(given) === puzzle.answer;
}

/** The one-line verdict, written for a person rather than a scoring engine. */
export function verdict(puzzle: Puzzle, mine: string | null, theirs: string | null): string {
  const youGot = isCorrect(puzzle, mine);
  const theyGot = isCorrect(puzzle, theirs);

  if (youGot && theyGot) return 'You both had it.';
  if (youGot) return 'You had it. Yours is the only one on the page.';
  if (theyGot) return 'You did not have it. Theirs was.';
  return 'Neither of you had it. That happens.';
}

/* ------------------------------------------------------------------ *
 * the letter streak                                                    *
 * ------------------------------------------------------------------ */

/**
 * Streaks, counted on the UTC calendar.
 *
 * UTC is not a detail here, it is the whole answer to "why did my streak break
 * while my pen pal's did not": you are each counting your own midnight. Counted
 * on UTC days, one exchange on one UTC day is one mark for both of you, always.
 *
 * Two deliberate refusals:
 *
 *   - `current` counts the run that ends on the most recent marked day. If that
 *     day is today or yesterday the run is still open; today is not over, so a
 *     person who wrote yesterday has not "lost" anything by not having written
 *     yet.
 *   - A broken run is not zero. `broken` carries how long it has been dark, and
 *     the page says so plainly instead of showing a zero and calling it a
 *     streak. Nothing in this product punishes absence.
 */
export interface Streak {
  /** Days in the run that ends on the last day a letter crossed. */
  current: number;
  /** The longest run ever recorded. This is the number worth showing. */
  longest: number;
  /** Most recent marked day, or null if no letter has ever crossed. */
  lastDay: string | null;
  /** True while the run is still open (last mark is today or yesterday). */
  alive: boolean;
  /** Days since the last exchange. 0 means today. */
  quietDays: number;
  /** The last `window` UTC days ending today, oldest first, for the strip. */
  marks: { day: string; marked: boolean }[];
}

export function computeStreak(days: string[], todayStr: string, window = 28): Streak {
  const marked = [...new Set(days)].sort();
  const todayMs = Date.parse(`${todayStr}T00:00:00.000Z`);
  const DAY_MS = 86400000;

  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of marked) {
    const ms = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isNaN(ms)) continue;
    run = previous !== null && ms - previous === DAY_MS ? run + 1 : 1;
    previous = ms;
    if (run > longest) longest = run;
  }

  // Walk back from the newest mark for as long as the days are consecutive.
  const lastDay = marked.length ? marked[marked.length - 1] : null;
  let current = 0;
  if (lastDay) {
    let cursor = Date.parse(`${lastDay}T00:00:00.000Z`);
    for (let i = marked.length - 1; i >= 0; i--) {
      if (Date.parse(`${marked[i]}T00:00:00.000Z`) !== cursor) break;
      current += 1;
      cursor -= DAY_MS;
    }
  }

  const quietDays = lastDay ? Math.max(0, Math.round((todayMs - Date.parse(`${lastDay}T00:00:00.000Z`)) / DAY_MS)) : -1;
  // A run whose newest mark is older than yesterday has been broken. Today's
  // own mark is not required: the day is not over.
  const alive = lastDay !== null && quietDays <= 1;

  const marks: { day: string; marked: boolean }[] = [];
  const set = new Set(marked);
  for (let i = window - 1; i >= 0; i--) {
    const day = new Date(todayMs - i * DAY_MS).toISOString().slice(0, 10);
    marks.push({ day, marked: set.has(day) });
  }

  return { current, longest, lastDay, alive, quietDays, marks };
}

/**
 * The one milestone worth saying out loud, chosen from the longest run.
 * Nothing here is a warning, and none of it resets.
 */
export function milestone(streak: Streak): string | null {
  if (streak.longest >= 365) return 'A full year of letters. That is the whole thing.';
  if (streak.longest >= 100) return 'One hundred days in a row, at least once.';
  if (streak.longest >= 30) return 'A month, unbroken, at least once.';
  if (streak.longest >= 7) return 'A week, unbroken, at least once.';
  return null;
}

/** `2026-03-14` -> "14 Mar 2026". Locale-independent on purpose: two people in
 *  two countries should read the same date. */
export function formatDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}