/**
 * /api/games — two-player chess over the wire (plan step 26).
 *
 * Mount it with:
 *
 *     app.use('/api/games', gameRoutes());
 *
 * before any inline handler for the same paths in server/index.js — Express takes
 * the first match, so a `use()` registered after them is dead code.
 *
 * ## The shape of the API
 *
 *     GET    /api/games              the pair's games, newest first (metadata only)
 *     GET    /api/games/active       the live game, or { game: null }
 *     POST   /api/games              start one (idempotent: returns the live one)
 *     GET    /api/games/:id          one game, with its envelopes
 *     POST   /api/games/:id/move     play a move
 *     POST   /api/games/:id/resign   resign
 *     POST   /api/games/:id/draw     offer a draw
 *     POST   /api/games/:id/draw/accept
 *     POST   /api/games/:id/draw/decline
 *     POST   /api/games/:id/undo     offer to take your last move back
 *     POST   /api/games/:id/undo/accept
 *     POST   /api/games/:id/undo/decline
 *
 * ## What this router refuses to do
 *
 *   - It never accepts a pair key, a board, or a user id from the body. `pair_key`
 *     comes from the caller's own `pairs` row; the sides come from that row; the
 *     position comes from an envelope it cannot open.
 *   - It never lets a player move out of turn, twice in a row, or after the game
 *     is over. See the refusals in server/repos/games.js.
 *   - It never grants a result nobody agreed to. A draw needs an offer and an
 *     acceptance from the *other* player; a take-back needs an acceptance from the
 *     other player too.
 *   - It never decrypts anything, so it cannot verify that a move was legal. That
 *     is the price of the same end-to-end promise letters make, and it is stated
 *     in the migration header rather than hidden here.
 */

const express = require('express');
const { authenticateToken, checkStr } = require('../lib/auth');
const gameRepo = require('../repos/games');

/** Repo refusal code -> HTTP status. Explicit, so no code silently 500s. */
const STATUS_FOR = {
  not_found: 404,
  not_open: 409,
  not_your_turn: 409,
  moved_twice: 409,
  wrong_side: 409,
  stale: 409,
  no_offer: 409,
  own_offer: 409,
  not_your_move: 409,
  nothing_to_undo: 409,
  bad_status: 400,
  not_paired: 409,
  no_vault: 400,
};

const MAX_ENVELOPE = 200_000;

/**
 * Structural validation of a position envelope, plus the two checks the server
 * can meaningfully make without a key.
 *
 * Beyond shape:
 *
 *   1. `senderId` must be the caller. Otherwise any authenticated user could
 *      post an envelope they found somewhere into a game they are playing, and
 *      the recipient would open a position neither of them wrote.
 *   2. The wrapped content key must exist for BOTH players. A position one side
 *      cannot open is not a shared game — it is a game that breaks the moment
 *      that side refreshes, which is the reconnect guarantee this whole feature
 *      rests on. (Letters only require the recipient's copy; a position is
 *      different, because both sides keep reading it after it is sent.)
 */
function parsePositionEnvelope(raw, { userId, partnerId }) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: 'The position was not a readable envelope.' };
  }
  if (!value || typeof value !== 'object') return { error: 'The position was not a readable envelope.' };

  const { v, ct, iv, keys, senderId, recipientId, sentAt } = value;
  if (typeof v !== 'number' || typeof ct !== 'string' || ct.length < 1) {
    return { error: 'The position was not a sealed envelope.' };
  }
  if (typeof iv !== 'string' || iv.length < 1) return { error: 'The envelope had no initialisation vector.' };
  if (typeof sentAt !== 'string' || Number.isNaN(Date.parse(sentAt))) {
    return { error: 'The envelope had no valid timestamp.' };
  }
  if (!keys || typeof keys !== 'object') return { error: 'The envelope carried no content key.' };
  if (!Number.isInteger(senderId) || !Number.isInteger(recipientId)) {
    return { error: 'The envelope was not addressed.' };
  }
  if (senderId !== userId) return { error: 'That envelope was sealed by somebody else.' };
  if (recipientId !== partnerId) return { error: 'That envelope is addressed to somebody you are not paired with.' };
  for (const id of [userId, partnerId]) {
    if (typeof keys[String(id)] !== 'string' || keys[String(id)].length < 1) {
      return { error: 'That position could not be opened by both of you, so it was not stored.' };
    }
  }
  return { value };
}

/** Integer from a JSON body that may legitimately be absent. */
function optionalInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

/**
 * The game id from the path, or a 404 already sent.
 *
 * Express 5 dropped inline regex parameters (`/:id(\\d+)` throws at registration
 * time under path-to-regexp 8), so the route is declared plainly and the shape is
 * checked here — once, in one place, instead of in every handler.
 */
function gameIdOf(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'That game does not exist.' });
    return null;
  }
  return id;
}

module.exports = function gameRoutes() {
  const r = express.Router();
  const { getDb } = require('../db');

  /**
   * The repository, built on FIRST USE rather than when this router is
   * constructed.
   *
   * That is not defensive noise. `getDb()` returns whatever `initDB()` left
   * behind, and `initDB()` on a module instance that has not run yet opens a
   * database — but a caller that reaches this router through a different module
   * instance of `../db` gets `undefined` and every query below dies with
   * "cannot read properties of undefined". Building the repo lazily means the
   * only thing that has to have happened before the first request is the app
   * having started, which is a much weaker and much more true requirement than
   * "this router was mounted after initDB on this exact module instance".
   *
   * (This is not hypothetical: `tests/rituals.test.js` is currently failing on
   * exactly this, with `db.exec` on an undefined handle.)
   */
  let cached = null;
  const sideOf = (game, userId) => (userId === game.white_id ? 'w' : userId === game.black_id ? 'b' : null);
  const deadlineFor = (game) => {
    const limit = repo().turnTimeoutMs();
    if (limit <= 0) return null;
    const since = game.last_move_at || game.created_at;
    const t = Date.parse(since);
    return Number.isNaN(t) ? null : new Date(t + limit).toISOString();
  };

  const repo = () => {
    if (!cached) {
      const db = getDb();
      if (!db) {
        throw new Error(
          'the database is not initialised — games routes were reached before initDB() ran',
        );
      }
      cached = gameRepo(db);
      cached.ensureSchema();
    }
    return cached;
  };

  r.use(authenticateToken);

  /** Everything a route needs about the caller, or null with a 409 already sent.
   *  `pal` selects which of the caller's pen pals the game is for; it is
   *  re-derived against `pairs` in the repo, so a forged id fails closed. */
  const pairOf = (req, res) => {
    const pal = req.query.pal ?? req.body?.pal;
    const pair = repo().pairFor(req.user.id, pal);
    if (!pair) {
      res.status(409).json({ error: pal ? 'That person is not your pen pal.' : 'You are not paired with anyone yet.', paired: false });
      return null;
    }
    return pair;
  };

  /** Maps a repo refusal onto the response. Returns true when it answered. */
  const sendRefusal = (res, result) => {
    if (result.ok) return false;
    const status = STATUS_FOR[result.code] || 409;
    const body = { error: result.message, code: result.code };
    // A stale write carries the current session back, so the losing client can
    // resync in one round trip instead of guessing what the board now is.
    if (result.game) body.game = publicGame(result.game, null);
    res.status(status).json(body);
    return true;
  };

  /** The wire shape of a session. Envelopes are opaque strings, always. */
  function publicGame(game, userId) {
    const mine = userId === null ? null : sideOf(game, userId);
    return {
      id: game.id,
      pairKey: game.pair_key,
      whiteId: game.white_id,
      blackId: game.black_id,
      youAre: mine,
      turn: game.turn,
      status: game.status,
      winnerId: game.winner_id,
      youWon: userId !== null && game.winner_id !== null && game.winner_id === userId,
      moveCount: game.move_count,
      lastMoveBy: game.last_move_by,
      lastMoveAt: game.last_move_at,
      version: game.version,
      encryptedState: game.encrypted_state,
      undo: game.undo_requested_by
        ? {
            offeredBy: game.undo_requested_by,
            fromYou: userId !== null && game.undo_requested_by === userId,
            encryptedState: game.encrypted_undo,
          }
        : null,
      draw: game.draw_offered_by
        ? {
            offeredBy: game.draw_offered_by,
            fromYou: userId !== null && game.draw_offered_by === userId,
          }
        : null,
      turnDeadline: deadlineFor(game),
      createdBy: game.created_by,
      createdAt: game.created_at,
      updatedAt: game.updated_at,
      closedAt: game.closed_at,
    };
  }

  /** Metadata only — a listing must not ship every sealed position in the archive. */
  function summarise(game, userId) {
    return {
      id: game.id,
      status: game.status,
      turn: game.turn,
      youAre: sideOf(game, userId),
      moveCount: game.move_count,
      winnerId: game.winner_id,
      version: game.version,
      updatedAt: game.updated_at,
      closedAt: game.closed_at,
    };
  }

  /* ---------------------------------------------------------------- *
   * reads                                                             *
   * ---------------------------------------------------------------- */

  r.get('/', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const games = repo().listFor(pair.pairKey, limit).map((g) => summarise(g, req.user.id));
    res.json({ games, partner: { id: pair.partnerId }, activeId: games.find((g) => g.status === 'open')?.id ?? null });
  });

  r.get('/active', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const game = repo().activeFor(pair.pairKey);
    res.json({ game: game ? publicGame(game, req.user.id) : null });
  });

  r.get('/:id', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const gameId = gameIdOf(req, res);
    if (gameId === null) return;
    const game = repo().getFor(gameId, pair.pairKey);
    if (!game) return res.status(404).json({ error: 'That game does not exist.' });
    res.json({ game: publicGame(game, req.user.id) });
  });

  /* ---------------------------------------------------------------- *
   * starting                                                          *
   * ---------------------------------------------------------------- */

  r.post('/', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;

    const { color, encryptedState } = req.body || {};
    if (color !== undefined && color !== 'w' && color !== 'b') {
      return res.status(400).json({ error: 'color must be "w" or "b".' });
    }
    const bad = checkStr(encryptedState, { required: true, min: 1, max: MAX_ENVELOPE });
    if (bad) return res.status(400).json({ error: `Invalid starting position: ${bad}` });

    const parsed = parsePositionEnvelope(encryptedState, {
      userId: req.user.id,
      partnerId: pair.partnerId,
    });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { game, created } = repo().createGame({
      pairKey: pair.pairKey,
      userId: req.user.id,
      partnerId: pair.partnerId,
      color: color ?? 'w',
      encryptedState,
    });

    res.status(created ? 201 : 200).json({ created, game: publicGame(game, req.user.id) });
  });

  /* ---------------------------------------------------------------- *
   * playing                                                           *
   * ---------------------------------------------------------------- */

  r.post('/:id/move', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const gameId = gameIdOf(req, res);
    if (gameId === null) return;

    const { color, status, encryptedState, version } = req.body || {};
    if (color !== 'w' && color !== 'b') return res.status(400).json({ error: 'color must be "w" or "b".' });
    const bad = checkStr(encryptedState, { required: true, min: 1, max: MAX_ENVELOPE });
    if (bad) return res.status(400).json({ error: `Invalid position: ${bad}` });

    const parsed = parsePositionEnvelope(encryptedState, {
      userId: req.user.id,
      partnerId: pair.partnerId,
    });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const result = repo().playMove({
      gameId,
      pairKey: pair.pairKey,
      userId: req.user.id,
      color,
      status: status || 'open',
      encryptedState,
      version: optionalInt(version),
    });
    if (sendRefusal(res, result)) return;

    res.json({
      accepted: true,
      ply: result.ply,
      game: publicGame(result.row, req.user.id),
    });
  });

  /* ---------------------------------------------------------------- *
   * endings                                                           *
   * ---------------------------------------------------------------- */

  r.post('/:id/resign', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const gameId = gameIdOf(req, res);
    if (gameId === null) return;
    const result = repo().resignGame({ gameId, pairKey: pair.pairKey, userId: req.user.id });
    if (sendRefusal(res, result)) return;
    res.json({ resigned: true, game: publicGame(result.row, req.user.id) });
  });

  /** Every negotiation verb shares this shape: nothing but the id and the pair. */
  const negotiation = (path, fn, verb) => {
    r.post(`/:id/${path}`, (req, res) => {
      const pair = pairOf(req, res);
      if (!pair) return;
      const gameId = gameIdOf(req, res);
      if (gameId === null) return;
      const result = fn({ gameId, pairKey: pair.pairKey, userId: req.user.id });
      if (sendRefusal(res, result)) return;
      res.json({ [verb]: true, game: publicGame(result.row, req.user.id) });
    });
  };

  negotiation('draw', (...args) => repo().offerDraw(...args), 'offered');
  negotiation('draw/accept', (...args) => repo().acceptDraw(...args), 'drawn');
  negotiation('draw/decline', (...args) => repo().declineDraw(...args), 'declined');

  negotiation('undo/decline', (...args) => repo().declineUndo(...args), 'declined');

  r.post('/:id/undo', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const gameId = gameIdOf(req, res);
    if (gameId === null) return;

    const { encryptedState, version } = req.body || {};
    const bad = checkStr(encryptedState, { required: true, min: 1, max: MAX_ENVELOPE });
    if (bad) return res.status(400).json({ error: `Invalid position: ${bad}` });

    const parsed = parsePositionEnvelope(encryptedState, {
      userId: req.user.id,
      partnerId: pair.partnerId,
    });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const result = repo().offerUndo({
      gameId,
      pairKey: pair.pairKey,
      userId: req.user.id,
      encryptedState,
      version: optionalInt(version),
    });
    if (sendRefusal(res, result)) return;
    res.json({ offered: true, game: publicGame(result.row, req.user.id) });
  });

  r.post('/:id/undo/accept', (req, res) => {
    const pair = pairOf(req, res);
    if (!pair) return;
    const gameId = gameIdOf(req, res);
    if (gameId === null) return;
    const result = repo().acceptUndo({
      gameId,
      pairKey: pair.pairKey,
      userId: req.user.id,
      // Required here, not optional: accepting rewinds the board, and rewinding
      // onto a position that has moved on would silently discard a real move.
      version: optionalInt(req.body?.version),
    });
    if (sendRefusal(res, result)) return;
    res.json({ accepted: true, game: publicGame(result.row, req.user.id) });
  });

  return r;
};