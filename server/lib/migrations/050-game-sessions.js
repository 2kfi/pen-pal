/**
 * 050-game-sessions — chess over the wire (plan step 26).
 *
 * One table. Every column is either ciphertext, a clock, or something the server
 * already owned about a pair (who they are, whose turn it is).
 *
 * ## There is no `position`, no `fen`, and no `san` column
 *
 * That is the whole point. v0.0.2 would have stored the board. This schema
 * cannot: `encrypted_state` holds a `LetterEnvelope` — AES-256-GCM over the
 * position, with the content key wrapped once per player with RSA-OAEP — which
 * is byte-for-byte the format `client/src/lib/crypto.ts` already produces for
 * letters, so the same sealing code seals a letter and a chess move.
 *
 * The cost of that choice is stated rather than hidden, because it is a real
 * one: **the server cannot check that a move was legal.** It cannot even check
 * that the position you sent is the position your move produces. Turn order,
 * pairing, session state and result transitions are all still enforced here,
 * because those need no knowledge of the board. Legality is enforced by the two
 * perft-verified rules engines at the two ends, and a client that lies can only
 * lie to itself — the pair's shared record will simply stop making sense to
 * them, which is visible, and it cannot be laundered past a third party.
 *
 * The alternative — the server holding positions to validate moves — is exactly
 * the thing this app does not do with letters, and doing it for chess would make
 * the chess the weakest link in the archive.
 *
 * ## What IS in the clear, and why it leaks nothing
 *
 *   turn        One character, and it alternates. Given `move_count`, which is
 *               already implied by "a move happened", it carries no information
 *               a watcher of timestamps did not already have.
 *   status      open/checkmate/stalemate/draw/resigned/timeout. The app has to
 *               be able to stop showing a board after a resignation without
 *               decrypting anything.
 *   move_count  A counter. It does not say *what* moved or where.
 *   version     Optimistic-concurrency token, not game state.
 */

const NAME = 'game-sessions';

const SQL = `
-- One row per game. ` + '`pair_key`' + ` is the canonical "7-11" of the two user
-- ids, derived server-side from the caller's ` + '`pairs`' + ` row and never
-- accepted from a request body, so no request shape reaches another pair's game.
CREATE TABLE IF NOT EXISTS game_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  pair_key          TEXT    NOT NULL,
  white_id          INTEGER NOT NULL,
  black_id          INTEGER NOT NULL,

  -- 'w' or 'b'. The only board-adjacent fact stored in the clear.
  turn              TEXT    NOT NULL DEFAULT 'w' CHECK (turn IN ('w', 'b')),
  status            TEXT    NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','checkmate','stalemate','draw','resigned','timeout')),
  -- NULL while the game is running, and NULL for every draw.
  winner_id         INTEGER,

  move_count        INTEGER NOT NULL DEFAULT 0,
  -- A LetterEnvelope over { fen, turn, castling, ep, halfmove, fullmove, moves[] }.
  -- Sealed by whoever made the last move, wrapped to BOTH players so each can
  -- re-read the position after a refresh without asking the other for it.
  encrypted_state   TEXT    NOT NULL,
  last_move_by      INTEGER,
  last_move_at      TEXT,

  -- Offer-undo. The player who just moved offers to take it back; the position
  -- one ply earlier arrives with the offer, already sealed, and is only promoted
  -- to the live state when the opponent accepts. Until then the board does not
  -- move, so an offer cannot be used to rewrite history.
  undo_requested_by INTEGER,
  encrypted_undo    TEXT,

  -- Draw by agreement. Same shape, same rule: nothing changes until both agree.
  draw_offered_by   INTEGER,

  -- Bumped on every state change. A move sent against a stale version is
  -- rejected with the current state, which is what makes "two tabs open, both
  -- moved" a recoverable conflict instead of a lost position.
  version           INTEGER NOT NULL DEFAULT 1,

  created_by        INTEGER NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at         TEXT
);

-- Newest-first listing for a pair.
CREATE INDEX IF NOT EXISTS idx_game_sessions_pair ON game_sessions(pair_key, id DESC);

-- One open game per pair, as a storage guarantee rather than a convention.
--
-- PenPal is a correspondence: two people, one board at a time. Making this a
-- partial UNIQUE index means a double-tap on "New game" cannot produce two live
-- boards that each half the pair is looking at, and it means the rule survives a
-- bug in the route. Finished games are unconstrained, so the archive is
-- unbounded in both directions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_sessions_one_open
  ON game_sessions(pair_key) WHERE status = 'open';
`;

module.exports = {
  name: NAME,
  up(db) {
    db.exec(SQL);
  },
  /**
   * For humans. The runner never calls this — rollback means restoring a backup,
   * see docs/MIGRATION.md. Dropping the table destroys every game record, so it
   * is here to be read, not to be run casually.
   */
  down(db) {
    db.exec('DROP INDEX IF EXISTS idx_game_sessions_one_open; DROP TABLE IF EXISTS game_sessions;');
  },
};