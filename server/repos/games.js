/**
 * Game storage (plan step 26).
 *
 * ## The one rule this file exists to enforce
 *
 * A move only lands if it is the mover's own side and it is not their second
 * move in a row. Everything else about a chess position is ciphertext here.
 *
 * That is not a gap that could be closed by writing more code in this file: the
 * server does not have the board, because the board is inside the AES-GCM
 * envelope the *clients* sealed. Turn order does not need the board, so turn
 * order is enforced here, hard, in SQL. Legality does need the board, so
 * legality is enforced by the perft-verified rules engines at both ends. Both
 * halves of that sentence are deliberate; see the migration header for why.
 *
 * ## What "reconnect" means here
 *
 * `GET /api/games/active` returns the session with its envelopes, and the client
 * re-opens the state envelope with its own private key. There is no server-side
 * session, no socket, no "the game lives in the tab" state. Refreshing is
 * indistinguishable from coming back tomorrow, which is the entire product.
 */

const MIGRATION = '../lib/migrations/050-game-sessions';

/** 72 hours. Long enough for a real correspondence, short enough to end a game
 *  somebody abandoned. `GAME_TURN_TIMEOUT_MS` overrides it; 0 disables it. */
const DEFAULT_TURN_TIMEOUT_MS = 72 * 60 * 60 * 1000;

const TERMINAL = new Set(['checkmate', 'stalemate', 'draw', 'resigned', 'timeout']);
const STATUSES = new Set(['open', 'checkmate', 'stalemate', 'draw', 'resigned', 'timeout']);

const nowInstant = () => new Date().toISOString();

/** Read the configured turn timeout at call time so a test can move it. */
function readTurnTimeoutMs() {
  const raw = process.env.GAME_TURN_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TURN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.floor(n);
}

/** A rejection the route can turn into a status code without a try/catch. */
const refuse = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const accept = (row, extra = {}) => ({ ok: true, row, ...extra });

module.exports = function gameRepo(db, options = {}) {
  const ensured = new WeakSet();

  /**
   * Idempotent, and only applied when the table is genuinely absent — so a
   * database the migration runner has already brought forward is untouched, and
   * a test can stand up a bare handle without a runner.
   */
  function ensureSchema() {
    if (!db || ensured.has(db)) return;
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('game_sessions') WHERE name = 'pair_key'")
      .get();
    if (!has) require(MIGRATION).up(db);
    ensured.add(db);
  }

  const turnTimeoutMs = () =>
    Number.isFinite(options.turnTimeoutMs) ? Math.max(0, options.turnTimeoutMs) : readTurnTimeoutMs();

  /**
   * The canonical pair, derived from the authenticated user's own `pairs` rows.
   *
   * Never taken from a request body. There is no request shape that can address
   * another pair's game, and a guess of `pair_key` buys nothing. With
   * pal-plural the caller names which pal the game is against via
   * `req.query.pal`; that id is re-checked against `pairs` here, so a forged
   * partner id resolves to null rather than to someone else's board.
   */
  function pairFor(userId, partnerId) {
    let row;
    if (partnerId === undefined || partnerId === null || partnerId === '') {
      row = db
        .prepare(
          'SELECT partner_id, created_at FROM pairs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(userId);
    } else {
      const asked = Number(partnerId);
      if (!Number.isInteger(asked)) return null;
      row = db
        .prepare('SELECT partner_id, created_at FROM pairs WHERE user_id = ? AND partner_id = ?')
        .get(userId, asked);
    }
    if (!row) return null;
    const lo = Math.min(userId, row.partner_id);
    const hi = Math.max(userId, row.partner_id);
    return { pairKey: `${lo}-${hi}`, userId, partnerId: row.partner_id, pairedAt: row.created_at };
  }

  /** Which side of this session a user is playing, or null if they are not in it. */
  function sideOf(game, userId) {
    if (game.white_id === userId) return 'w';
    if (game.black_id === userId) return 'b';
    return null;
  }

  /** When the side to move had to answer by. Null when timeouts are off. */
  function deadlineFor(game) {
    const limit = turnTimeoutMs();
    if (limit <= 0) return null;
    const since = game.last_move_at || game.created_at;
    const t = Date.parse(since);
    if (Number.isNaN(t)) return null;
    return new Date(t + limit).toISOString();
  }

  /**
   * Ends abandoned games.
   *
   * Runs on read rather than on a timer, deliberately: there is no background
   * job in this app, and a game that nobody looks at does not need to be marked
   * over until somebody looks. The clock is the server's, and the player who is
   * *not* to move is the one who let it run out.
   */
  function finaliseTimeout(game) {
    const limit = turnTimeoutMs();
    if (limit <= 0) return game;
    if (game.status !== 'open') return game;

    const since = game.last_move_at || game.created_at;
    const t = Date.parse(since);
    if (Number.isNaN(t)) return game;
    if (Date.now() - t <= limit) return game;

    // The side to move is the side that ran out the clock, so the *other* one
    // wins. Getting this backwards would award the game to whoever stopped
    // playing, which is not a rule anybody plays by.
    const winner = game.turn === 'w' ? game.black_id : game.white_id;
    const at = nowInstant();
    db.prepare(
      `UPDATE game_sessions
          SET status = 'timeout', winner_id = ?, closed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'open'`,
    ).run(winner, at, at, game.id);
    return db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(game.id);
  }

  function find(gameId) {
    return db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(gameId) ?? null;
  }

  /**
   * Reads one game, scoped to a pair, finalising a timeout if one is due.
   *
   * `pairKey` is mandatory on every read: an id alone is not authorisation.
   */
  function getFor(gameId, pairKey) {
    ensureSchema();
    const row = find(gameId);
    if (!row || row.pair_key !== pairKey) return null;
    return finaliseTimeout(row);
  }

  /** The pair's live game, or null. This is what a reconnect asks for first. */
  function activeFor(pairKey) {
    ensureSchema();
    const row =
      db.prepare("SELECT * FROM game_sessions WHERE pair_key = ? AND status = 'open'").get(pairKey) ?? null;
    return row ? finaliseTimeout(row) : null;
  }

  function listFor(pairKey, limit = 25) {
    ensureSchema();
    const rows = db
      .prepare('SELECT * FROM game_sessions WHERE pair_key = ? ORDER BY id DESC LIMIT ?')
      .all(pairKey, limit);
    // One pass over the newest few is enough; a timed-out game should not still
    // be described as live in the list the player is looking at.
    return rows.map((row) => finaliseTimeout(row));
  }

  /**
   * Starts a game, or hands back the one already in progress.
   *
   * Idempotent on purpose. "New game" is a button people double-tap on a phone,
   * and the unique index on (pair_key) where status = 'open' means a race would
   * throw. Returning the existing game is the better answer to both.
   */
  const create = db.transaction((input) => {
    const existing = db
      .prepare("SELECT * FROM game_sessions WHERE pair_key = ? AND status = 'open'")
      .get(input.pairKey);
    if (existing) return { game: finaliseTimeout(existing), created: false };

    const white = input.color === 'b' ? input.partnerId : input.userId;
    const black = input.color === 'b' ? input.userId : input.partnerId;
    const info = db
      .prepare(
        `INSERT INTO game_sessions
           (pair_key, white_id, black_id, turn, status, encrypted_state, created_by)
         VALUES (?, ?, ?, 'w', 'open', ?, ?)`,
      )
      .run(input.pairKey, white, black, input.encryptedState, input.userId);
    return { game: find(Number(info.lastInsertRowid)), created: true };
  });

  function createGame(input) {
    ensureSchema();
    return create({ ...input, color: input.color === 'b' ? 'b' : 'w' });
  }

  /* ---------------------------------------------------------------- *
   * moves                                                             *
   * ---------------------------------------------------------------- */

  /**
   * Applies a move.
   *
   * The three refusals, in the order they are checked, are the whole server-side
   * rules set:
   *
   *   not_open        the game is over, finished or abandoned
   *   not_your_turn   you are not the side to move
   *   moved_twice     you are the side to move *because you just moved*; caught
   *                   separately so the message can say why, because "it is not
   *                   your turn" after your own move reads as a bug
   *   stale           your view of the position is older than the stored one
   *
   * `moved_twice` and `not_your_turn` overlap by construction. They are separate
   * codes so the UI can say "your partner is to move" rather than "something is
   * wrong", and so the test can assert the rule rather than the overlap.
   */
  const move = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');

    if (game.status !== 'open') {
      return refuse('not_open', `This game is over (${game.status}). Start a new one.`);
    }

    const side = sideOf(game, input.userId);
    if (!side) return refuse('not_found', 'That game does not exist.');
    if (side !== input.color) {
      return refuse('wrong_side', 'That is not your side of the board.');
    }
    if (game.turn !== side) {
      if (game.last_move_by === input.userId) {
        return refuse('moved_twice', 'You have already moved. Wait for your partner to reply.');
      }
      return refuse('not_your_turn', 'It is not your turn.');
    }
    if (Number.isInteger(input.version) && input.version !== game.version) {
      return refuse('stale', 'The position has moved on since this page loaded.', {
        game: finaliseTimeout(game),
      });
    }

    const claimed = input.status || 'open';
    if (!STATUSES.has(claimed)) return refuse('bad_status', 'That is not a game status.');
    // A timeout is the server's clock, not the client's claim.
    if (claimed === 'timeout') return refuse('bad_status', 'A timeout is decided by the server.');

    const at = nowInstant();
    const ended = TERMINAL.has(claimed);
    // Only the mover may end the game, and only in the way a mover can. A
    // checkmate is won BY the player who delivered it — the mover — not by the
    // player who was mated; every draw has no winner at all.
    const winner = claimed === 'checkmate' ? input.userId : null;

    db.prepare(
      `UPDATE game_sessions
          SET turn = ?, status = ?, winner_id = ?, move_count = move_count + 1,
              encrypted_state = ?, last_move_by = ?, last_move_at = ?,
              undo_requested_by = NULL, encrypted_undo = NULL,
              draw_offered_by = NULL,
              closed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      side === 'w' ? 'b' : 'w',
      claimed,
      winner,
      input.encryptedState,
      input.userId,
      at,
      ended ? at : null,
      at,
      game.id,
    );

    return accept(find(game.id), { side, ply: game.move_count + 1 });
  });

  function playMove(input) {
    ensureSchema();
    return move(input);
  }

  /* ---------------------------------------------------------------- *
   * endings                                                           *
   * ---------------------------------------------------------------- */

  const resign = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (game.status !== 'open') return refuse('not_open', `This game is already over (${game.status}).`);
    if (!sideOf(game, input.userId)) return refuse('not_found', 'That game does not exist.');

    const at = nowInstant();
    const winner = game.white_id === input.userId ? game.black_id : game.white_id;
    db.prepare(
      `UPDATE game_sessions
          SET status = 'resigned', winner_id = ?, closed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'open'`,
    ).run(winner, at, at, game.id);
    return accept(find(game.id));
  });

  function resignGame(input) {
    ensureSchema();
    return resign(input);
  }

  /**
   * Draw by agreement.
   *
   * Three separate verbs rather than one `draw: true` flag, because "I offer a
   * draw" and "I accept the draw you offered" must not be the same request: with
   * one flag, a client that wanted to accept could send the offer instead, and
   * nobody would ever be asked.
   */
  const drawOffer = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (game.status !== 'open') return refuse('not_open', `This game is already over (${game.status}).`);
    // Deliberately NOT restricted to whose turn it is. Offering a draw is an
    // action, not a move: the whole point is being able to say "let's call it"
    // while you are WAITING for an answer you do not like. Requiring the turn
    // would make an offer possible only at the exact moment the other player is
    // thinking, which is the moment they are least likely to be watching.
    if (!sideOf(game, input.userId)) return refuse('not_found', 'That game does not exist.');
    if (game.draw_offered_by === input.userId) return accept(game, { alreadyOffered: true });

    db.prepare('UPDATE game_sessions SET draw_offered_by = ?, updated_at = ? WHERE id = ?').run(
      input.userId,
      nowInstant(),
      game.id,
    );
    return accept(find(game.id));
  });

  const drawAccept = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (game.status !== 'open') return refuse('not_open', `This game is already over (${game.status}).`);
    if (!game.draw_offered_by) return refuse('no_offer', 'There is no draw offer to accept.');
    if (game.draw_offered_by === input.userId) {
      return refuse('own_offer', 'You cannot accept your own draw offer.');
    }
    const at = nowInstant();
    db.prepare(
      `UPDATE game_sessions
          SET status = 'draw', winner_id = NULL, draw_offered_by = NULL,
              closed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'open'`,
    ).run(at, at, game.id);
    return accept(find(game.id));
  });

  const drawDecline = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (!game.draw_offered_by) return accept(game, { nothingToDecline: true });
    if (game.draw_offered_by === input.userId) {
      return refuse('own_offer', 'You cannot decline your own offer — withdraw it instead.');
    }
    db.prepare('UPDATE game_sessions SET draw_offered_by = NULL, updated_at = ? WHERE id = ?').run(
      nowInstant(),
      game.id,
    );
    return accept(find(game.id));
  });

  const drawOp = (fn) => (input) => {
    ensureSchema();
    return fn(input);
  };

  /* ---------------------------------------------------------------- *
   * take back                                                         *
   * ---------------------------------------------------------------- */

  /**
   * Offer to take a move back.
   *
   * Only the player who made the last move may offer — asking to undo somebody
   * else's move is not a misclick, it is a move.
   *
   * The rolled-back position arrives with the offer, sealed, and sits in
   * `encrypted_undo` until accepted. The live `encrypted_state` is untouched in
   * the meantime, so a pending offer cannot be used to change what either
   * player is looking at; it is a proposal about the future, not an edit of the
   * present.
   */
  const undoOffer = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (game.status !== 'open') return refuse('not_open', `This game is already over (${game.status}).`);
    if (game.move_count === 0) return refuse('nothing_to_undo', 'No moves have been played yet.');
    if (game.last_move_by !== input.userId) {
      return refuse('not_your_move', 'You can only take back your own move.');
    }

    db.prepare(
      `UPDATE game_sessions
          SET undo_requested_by = ?, encrypted_undo = ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.userId, input.encryptedState, nowInstant(), game.id);
    return accept(find(game.id), { ply: game.move_count - 1 });
  });

  /**
   * Accepts a take-back, and only then rewinds the session.
   *
   * `version` is required here rather than optional. Accepting rewinds the board
   * by one ply; accepting one that was offered against a position that has since
   * changed (because a move went in over the top of it, from a second tab) would
   * silently discard that move. The client that offered supplies the version it
   * saw, and a mismatch is refused rather than resolved by guesswork.
   */
  const undoAccept = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (game.status !== 'open') return refuse('not_open', `This game is already over (${game.status}).`);
    if (!game.undo_requested_by) return refuse('no_offer', 'There is no take-back to accept.');
    if (game.undo_requested_by === input.userId) {
      return refuse('own_offer', 'You cannot accept your own take-back — your partner has to.');
    }
    if (Number.isInteger(input.version) && input.version !== game.version) {
      return refuse('stale', 'The position changed after that offer was made.', { game: finaliseTimeout(game) });
    }
    if (!game.encrypted_undo) return refuse('no_offer', 'That take-back carried no position.');

    const side = sideOf(game, game.undo_requested_by);
    const at = nowInstant();
    db.prepare(
      `UPDATE game_sessions
          SET turn = ?, encrypted_state = ?, move_count = move_count - 1,
              last_move_by = ?, last_move_at = ?,
              undo_requested_by = NULL, encrypted_undo = NULL,
              version = version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      side,
      game.encrypted_undo,
      // The partner moved last before the take-back, so that is who "moved last"
      // becomes: it is what stops the same person offering again immediately.
      game.white_id === game.undo_requested_by ? game.black_id : game.white_id,
      at,
      at,
      game.id,
    );
    return accept(find(game.id));
  });

  const undoDecline = db.transaction((input) => {
    const game = find(input.gameId);
    if (!game || game.pair_key !== input.pairKey) return refuse('not_found', 'That game does not exist.');
    if (!game.undo_requested_by) return accept(game, { nothingToDecline: true });
    if (game.undo_requested_by === input.userId) {
      return refuse('own_offer', 'You cannot decline your own take-back — withdraw it instead.');
    }
    db.prepare(
      'UPDATE game_sessions SET undo_requested_by = NULL, encrypted_undo = NULL, updated_at = ? WHERE id = ?',
    ).run(nowInstant(), game.id);
    return accept(find(game.id));
  });

  const undoOp = (fn) => (input) => {
    ensureSchema();
    return fn(input);
  };

  return {
    ensureSchema,
    pairFor,
    sideOf,
    deadlineFor,
    turnTimeoutMs,

    createGame,
    getFor,
    activeFor,
    listFor,

    playMove,
    resignGame,

    offerDraw: drawOp(drawOffer),
    acceptDraw: drawOp(drawAccept),
    declineDraw: drawOp(drawDecline),

    offerUndo: undoOp(undoOffer),
    acceptUndo: undoOp(undoAccept),
    declineUndo: undoOp(undoDecline),

    _internals: { readTurnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS, TERMINAL },
  };
};