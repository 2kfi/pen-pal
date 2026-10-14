/**
 * 060-rituals — shared rituals (plan step 27).
 *
 * Three tables, and every column in every one of them holds ciphertext or a
 * timestamp. There is no `answer` column, no `is_correct` column and no
 * `streak` column, because this schema must not be able to express them: the
 * server has no vocabulary for a right answer or a score.
 *
 * The daily puzzle is derived from `pair_key` + `day` by a seeded PRNG that runs
 * in the browser, so the server can store both sides' submissions and still not
 * know what either of them said. Grading happens on the client, which is the
 * only place the answer exists.
 *
 * `pair_key` is a canonical string of the two user ids in ascending order
 * ("7-11"), computed server-side from the authenticated `pairs` row. It is never
 * accepted from a request body — otherwise a user could address another pair's
 * puzzle by guessing a key.
 */

const NAME = 'rituals';

const SQL = `
-- One row per (pair, UTC day, person). The primary key is what makes "one
-- answer a day" a storage guarantee rather than a convention: a second submit
-- for the same day is an UPSERT, not a duplicate the UI has to filter out.
CREATE TABLE IF NOT EXISTS ritual_puzzles (
  pair_key TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  -- A LetterEnvelope: { v, ct, iv, keys, senderId, recipientId, sentAt }.
  -- ct is AES-256-GCM over the answer; keys holds the content key wrapped once
  -- per party with RSA-OAEP-2048.
  encrypted_answer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (pair_key, day, user_id)
);

-- Days on which an answer exists, for the pair/day lookup the reveal needs.
CREATE INDEX IF NOT EXISTS idx_ritual_puzzles_pair_day ON ritual_puzzles(pair_key, day);

-- The ritual ledger: streak counts, day marks and the pair's chosen anniversary
-- date, sealed with the same envelope as a letter. The server stores the
-- envelope and a timestamp and nothing else it can read.
CREATE TABLE IF NOT EXISTS ritual_ledgers (
  pair_key TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  encrypted_state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (pair_key, user_id)
);
`;

module.exports = {
  name: NAME,
  up(db) {
    db.exec(SQL);
  },
};