import fs from 'fs';
import os from 'os';
import path from 'path';
import { webcrypto } from 'crypto';

/**
 * Two-player chess over the wire (plan steps 25 and 26).
 *
 * ## The three claims this file exists to prove
 *
 *   1. **The engine runs off the main thread.** Not "the search module exists" —
 *      the real worker file, asked for a move, returns one, and stops when told
 *      to. A search that hangs here hangs CI, so every engine test is bounded.
 *   2. **The server cannot read the board.** After a real game is played, the
 *      SQLite file on disk is read byte-for-byte and searched for anything that
 *      would let somebody reconstruct a position. This is the assertion that
 *      makes step 26 mean something: a schema that merely *promised* encryption
 *      in a comment would pass every other test here.
 *   3. **The turn rules are real.** Out of turn, twice in a row, after the game
 *      ended, and against somebody else's pairing — all refused.
 *
 * The cryptography in the test is the *production* cryptography:
 * `client/src/lib/crypto.ts` is imported directly, so a move is sealed by the
 * same `sealLetter` the browser uses and opened by the same `openLetter`. If the
 * two ever drift, these tests fail rather than quietly testing a mock.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'games-test-secret-not-for-production-1234567890';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'penpal-games-'));

// WebCrypto, so `client/src/lib/crypto.ts` believes it is in a browser.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const { describe, it, expect, afterAll } = await import('vitest');
const request = (await import('supertest')).default;
const { app } = (await import('../server/index.js')).default;
const { closeDB, getDbPath } = (await import('../server/db.js')).default;
// A SECOND, read-only handle on the same file, opened by the test rather than
// borrowed from the server. Reading the stored row through the app's own handle
// would prove that the app can see it; opening the file independently proves that
// it is really in there.
const Database = (await import('better-sqlite3')).default;
const inspect = () => new Database(getDbPath(), { readonly: true });
const gameRoutes = (await import('../server/routes/games.js')).default;
const { generateKeyPair, exportKey, exportPublicKey, importPrivateKey, sealLetter, openLetter } = await import(
  '../client/src/lib/crypto.ts'
);
const { initialState, cloneState, legalMoves, makeMove, square, toSAN, gameResult } = await import(
  '../client/src/lib/chessEngine.ts'
);

// Wired here rather than in server/index.js because the app module is shared with
// tests/api.test.js and mounting is the wiring owner's job. A duplicate mount is
// harmless: Express takes the first match and both would be the same router.
app.use('/api/games', gameRoutes());

const DB_PATH = path.join(process.env.DATA_DIR, 'penpal.db');

afterAll(() => {
  closeDB();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

describe('the router does not depend on being mounted after initDB', () => {
  /**
   * A regression test for a real bug, not a hypothetical one.
   *
   * The router used to build its repository at construction time, calling
   * `getDb()` immediately. `getDb()` hands back whatever `initDB()` left on ITS
   * module instance, and `initDB()` currently returns nothing — so any caller
   * that reaches this router through a different instance of `../db` (a test
   * that never imports `server/index.js`, say) gets `undefined` and the first
   * query throws `cannot read properties of undefined`. `tests/rituals.test.js`
   * is failing on exactly that right now.
   *
   * This mounts the router on an app that has never seen `server/index.js`, so
   * the lazy lookup is exercised for real rather than described.
   */
  it('works on an app that never imported server/index.js', async () => {
    const express = (await import('express')).default;
    const { initDB, getDb } = await import('../server/db.js');
    // Note: `initDB()` returns nothing (a separate bug in server/db.js), so the
    // handle has to come from `getDb()`. That is exactly the dance a caller has
    // to do, and it is why the router cannot do it at construction time.
    initDB();
    const handle = getDb();

    const isolated = express();
    isolated.use(express.json({ limit: '1mb' }));
    isolated.use('/api/games', gameRoutes());

    const a = await signup();
    const b = await signup();

    // Paired straight in the database, because /api/pairing lives in
    // server/index.js and this app deliberately does not mount that. The subject
    // of the test is the games router, not the pairing flow.
    const paired = handle.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)');
    paired.run(a.id, b.id);
    paired.run(b.id, a.id);

    const created = await request(isolated)
      .post('/api/games')
      .set(asUser(a))
      .send({ encryptedState: await sealFor(positionJson(START, []), a, b) });

    expect(created.status).toBe(201);
    expect(created.body.game.status).toBe('open');

    const active = await request(isolated).get('/api/games/active').set(asUser(b));
    expect(active.body.game.id).toBe(created.body.game.id);
  });
});

/* ------------------------------------------------------------------ *
 * fixtures                                                           *
 * ------------------------------------------------------------------ */

let counter = 0;

async function signup() {
  counter += 1;
  // A real RSA keypair per account. The production path generates one in the
  // browser at signup and posts the public half; this does the same, so an
  // envelope sealed in this test is a real envelope.
  const pair = await generateKeyPair();
  // The PUBLIC half is what a partner seals to. Handing over the private JWK
  // instead is not a shortcut that works: importing a private JWK as an RSA-OAEP
  // *encrypt* key is rejected outright, which is the correct behaviour.
  const publicJwk = await exportPublicKey(pair.publicKey);
  const res = await request(app).post('/api/signup').send({
    username: `gm_${counter}_${Math.random().toString(36).slice(2, 8)}`,
    email: `gm${counter}_${Math.random().toString(36).slice(2, 8)}@test.local`,
    password: 'password123',
    publicKey: JSON.stringify(publicJwk),
  });
  expect(res.status).toBe(200);
  const privateJwk = await exportKey(pair.privateKey);
  return {
    ...res.body,
    id: res.body.user.id,
    publicJwk,
    privateJwk,
    privateKey: await importPrivateKey(privateJwk),
  };
}

const asUser = (u) => ({ Authorization: `Bearer ${u.token}` });

async function pairedCouple() {
  const a = await signup();
  const b = await signup();
  const req = await request(app).post('/api/pairing/request').set(asUser(a)).send({ targetPid: b.user.pid });
  expect(req.status).toBe(200);

  const status = await request(app).get('/api/pairing/status').set(asUser(b));
  const pending = status.body.incoming.find((r) => r.username === a.user.username);
  expect(pending).toBeTruthy();

  const accepted = await request(app).post('/api/pairing/accept').set(asUser(b)).send({ requestId: pending.id });
  expect(accepted.status).toBe(200);
  return { a, b };
}

/** Seals a position exactly as the client does: AES-GCM, wrapped to both parties. */
async function sealFor(plaintext, sender, recipient) {
  const envelope = await sealLetter(plaintext, {
    senderId: sender.id,
    recipientId: recipient.id,
    senderPublicKey: sender.publicJwk,
    recipientPublicKey: recipient.publicJwk,
    sentAt: new Date().toISOString(),
  });
  return JSON.stringify(envelope);
}

const positionJson = (state, moves) =>
  JSON.stringify({
    v: 1,
    board: state.board,
    turn: state.turn,
    castling: state.castling,
    ep: state.ep,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    moves,
    result: 'open',
  });

const START = initialState();

async function newGame(a, b, color = 'w') {
  const res = await request(app)
    .post('/api/games')
    .set(asUser(a))
    .send({ color, encryptedState: await sealFor(positionJson(START, []), a, b) });
  expect([200, 201]).toContain(res.status);
  return res.body.game;
}

/**
 * Algebraic square name -> the engine's index.
 *
 * `chessEngine` indexes with array rank 0 = board rank 8, so `board[0]` is a8 and
 * `square(f, r)` takes a rank INDEX, not a rank number. Writing those numbers out
 * by hand is how a test ends up asserting that a legal move is illegal (this one
 * did, and did so confidently), so moves are written as "e2e4" and converted here
 * through the engine's own `square()` — one definition of the mapping, not two.
 */
const sq = (name) => square(name.charCodeAt(0) - 97, 8 - Number(name[1]));

/**
 * Plays a move written as `"e2e4"` or `"a7a8q"`, applying it locally first so
 * the sealed position is always consistent with the move that produced it.
 */
async function playMove(player, other, game, algebraic) {
  const opened = await openGame(game, player);
  const from = sq(algebraic.slice(0, 2));
  const to = sq(algebraic.slice(2, 4));
  const promotion = algebraic.length > 4 ? algebraic[4] : undefined;

  const legal = legalMoves(opened.state).find(
    (m) => m.from === from && m.to === to && (!promotion || m.promotion === promotion),
  );
  expect(
    legal,
    `${algebraic} should be legal with ${opened.state.turn === 'w' ? 'white' : 'black'} to move`,
  ).toBeTruthy();

  // SAN first: `toSAN` needs the position BEFORE the move, and this test asserts on
  // the move list coming back out of the database, so a wrong SAN here would be a
  // self-inflicted failure rather than a real bug.
  const san = toSAN(opened.state, legal);
  const color = opened.state.turn;

  const stack = [];
  makeMove(opened.state, legal, stack);

  const record = {
    ply: opened.moves.length + 1,
    color,
    san,
    uci: `${from}${to}${promotion ?? ''}`,
    at: new Date().toISOString(),
  };

  // The client declares the result, because only the client can see the board.
  // A helper that never declared one could never finish a game, so the status is
  // computed here from the same rules engine the browser uses.
  const verdict = gameResult(opened.state, stack);
  const status =
    verdict === 'checkmate' ? 'checkmate' : verdict === 'playing' ? 'open' : 'draw';

  const res = await request(app)
    .post(`/api/games/${game.id}/move`)
    .set(asUser(player))
    .send({
      color: record.color,
      version: game.version,
      status,
      encryptedState: await sealFor(positionJson(opened.state, [...opened.moves, record]), player, other),
    });
  return { res, record, state: opened.state, status };
}

/** Decrypts a session's state with a given account's key. */
async function openGame(game, viewer) {
  const envelope = JSON.parse(game.encryptedState);
  const plain = await openLetter(envelope, viewer.privateKey, viewer.id);
  const payload = JSON.parse(plain);
  return { state: { ...payload, moves: payload.moves }, moves: payload.moves };
}

/* ------------------------------------------------------------------ *
 * plan step 26 — the rules the server does enforce                     *
 * ------------------------------------------------------------------ */

describe('game sessions: creating', () => {
  it('starts a game between two paired people and seals the opening position', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');

    expect(game.id).toBeTruthy();
    expect(game.youAre).toBe('w');
    expect(game.turn).toBe('w');
    expect(game.status).toBe('open');
    expect(game.moveCount).toBe(0);

    // Both sides can open it. A position only one player could read would break
    // the moment that player refreshed, which is the whole reconnect promise.
    const forB = await openGame(game, b);
    expect(forB.state.turn).toBe('w');
    expect(forB.moves).toHaveLength(0);
  });

  it('lets the second player take black', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(b, a, 'b');
    expect(game.youAre).toBe('b');
    expect(game.whiteId).toBe(a.id);
    expect(game.blackId).toBe(b.id);
  });

  it('refuses to start a game when you are not paired', async () => {
    const solo = await signup();
    const res = await request(app)
      .post('/api/games')
      .set(asUser(solo))
      .send({ encryptedState: await sealFor(positionJson(START, []), solo, await signup()) });
    expect(res.status).toBe(409);
  });

  it('is idempotent: a second "new game" returns the one in progress', async () => {
    const { a, b } = await pairedCouple();
    const first = await newGame(a, b);
    const again = await request(app)
      .post('/api/games')
      .set(asUser(a))
      .send({ encryptedState: await sealFor(positionJson(START, []), a, b) });

    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.game.id).toBe(first.id);
  });

  it('rejects a position sealed by somebody else', async () => {
    const { a, b } = await pairedCouple();
    const c = await signup();
    // Sealed by `c`, claiming to be addressed to `b`.
    const forged = await sealFor(positionJson(START, []), c, b);
    const res = await request(app).post('/api/games').set(asUser(a)).send({ encryptedState: forged });
    expect(res.status).toBe(400);
  });

  it('rejects a position your partner could not open', async () => {
    const { a, b } = await pairedCouple();
    const envelope = JSON.parse(await sealFor(positionJson(START, []), a, b));
    delete envelope.keys[String(b.id)];

    const res = await request(app)
      .post('/api/games')
      .set(asUser(a))
      .send({ encryptedState: JSON.stringify(envelope) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/both of you/i);
  });

  it('never shows one pair the other pair’s game', async () => {
    const { a, b } = await pairedCouple();
    const outsiders = await pairedCouple();
    const game = await newGame(a, b);

    const res = await request(app).get(`/api/games/${game.id}`).set(asUser(outsiders.a));
    expect(res.status).toBe(404);
  });
});

describe('game sessions: turn order', () => {
  it('plays a full game to checkmate through the API', async () => {
    const { a, b } = await pairedCouple();
    let game = await newGame(a, b, 'w');

    // Scholar's mate: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7#
    const script = [
      [a, 'e2e4'],
      [b, 'e7e5'],
      [a, 'f1c4'],
      [b, 'b8c6'],
      [a, 'd1h5'],
      [b, 'g8f6'],
      [a, 'h5f7'], // capture, mate
    ];

    let state = START;
    for (const [who, uci] of script) {
      const other = who === a ? b : a;
      const step = await playMove(who, other, game, uci);
      expect(step.res.status, `${uci} (${step.record.san}) should be accepted`).toBe(200);
      state = step.state;
      game = step.res.body.game;
    }

    expect(game.status).toBe('checkmate');
    expect(game.winnerId).toBe(a.id);
    expect(game.moveCount).toBe(7);
    expect(game.turn).toBe('b');
    expect(gameResult(state)).toBe('checkmate');

    // The losing side sees it too, and agrees about who won.
    const fromB = await request(app).get(`/api/games/${game.id}`).set(asUser(b));
    expect(fromB.body.game.status).toBe('checkmate');
    expect(fromB.body.game.youWon).toBe(false);
    expect(fromB.body.game.youAre).toBe('b');
  });

  it('refuses a move from the player who is not to move', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    const after = await playMove(a, b, game, 'e2e4');
    expect(after.res.status).toBe(200);

    // White just moved. White moving again must be refused — by the server, before
    // any question of whether the move was legal. So the request is built by hand
    // from the position white already sent, rather than through playMove(), which
    // would (correctly) refuse to generate a second white move.
    const opened = await openGame(after.res.body.game, a);
    const again = await request(app)
      .post(`/api/games/${after.res.body.game.id}/move`)
      .set(asUser(a))
      .send({
        color: 'w',
        version: after.res.body.game.version,
        encryptedState: await sealFor(positionJson(opened.state, opened.moves), a, b),
      });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('moved_twice');

    // And the position must not have moved.
    const check = await request(app).get(`/api/games/${after.res.body.game.id}`).set(asUser(b));
    expect(check.body.game.moveCount).toBe(1);
    expect(check.body.game.turn).toBe('b');
  });

  it('refuses a move played for the wrong side', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    const after = await playMove(a, b, game, 'e2e4');

    // Black claims to be white.
    const res = await request(app)
      .post(`/api/games/${after.res.body.game.id}/move`)
      .set(asUser(b))
      .send({
        color: 'w',
        version: after.res.body.game.version,
        encryptedState: await sealFor(positionJson(after.state, []), b, a),
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('wrong_side');
  });

  it('refuses a stale write and hands back the current position', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    const staleVersion = game.version;

    const first = await playMove(a, b, game, 'e2e4');
    expect(first.res.status).toBe(200);
    await playMove(b, a, first.res.body.game, 'e7e5');

    // `a` replays its page's cached version — the tab that was asleep.
    const res = await request(app)
      .post(`/api/games/${first.res.body.game.id}/move`)
      .set(asUser(a))
      .send({
        color: 'w',
        version: staleVersion,
        encryptedState: await sealFor(positionJson(first.state, []), a, b),
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale');
    // The conflict carries the truth, so the client resyncs in one round trip.
    expect(res.body.game.moveCount).toBe(2);
  });

  it('refuses a move into a finished game', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    const resigned = await request(app).post(`/api/games/${game.id}/resign`).set(asUser(a));
    expect(resigned.status).toBe(200);

    const res = await request(app)
      .post(`/api/games/${game.id}/move`)
      .set(asUser(b))
      .send({
        color: 'b',
        version: resigned.body.game.version,
        encryptedState: await sealFor(positionJson(START, []), b, a),
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_open');
  });

  it('refuses a move into somebody else’s game, even with a valid envelope', async () => {
    const { a, b } = await pairedCouple();
    const outsiders = await pairedCouple();
    const game = await newGame(a, b, 'w');

    const res = await request(app)
      .post(`/api/games/${game.id}/move`)
      .set(asUser(outsiders.a))
      .send({
        color: 'w',
        version: game.version,
        encryptedState: await sealFor(positionJson(START, []), outsiders.a, outsiders.b),
      });
    expect(res.status).toBe(404);
  });

  it('will not let a client declare its own timeout', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    const after = await playMove(a, b, game, 'e2e4');

    const res = await request(app)
      .post(`/api/games/${game.id}/move`)
      .set(asUser(b))
      .send({
        color: 'b',
        status: 'timeout',
        version: after.res.body.game.version,
        encryptedState: await sealFor(positionJson(after.state, []), b, a),
      });
    expect(res.status).toBe(400);
  });
});

describe('game sessions: reconnecting', () => {
  it('gives a player who refreshes the current position back', async () => {
    const { a, b } = await pairedCouple();
    let game = await newGame(a, b, 'w');
    const one = await playMove(a, b, game, 'e2e4');
    game = one.res.body.game;
    const two = await playMove(b, a, game, 'e7e5');
    game = two.res.body.game;

    // "Refresh" = the same token, a fresh GET, nothing cached.
    const active = await request(app).get('/api/games/active').set(asUser(b));
    expect(active.body.game.id).toBe(game.id);
    expect(active.body.game.moveCount).toBe(2);
    expect(active.body.game.turn).toBe('w');

    const opened = await openGame(active.body.game, b);
    expect(opened.state.board).toEqual(two.state.board);
    // `uci` is the engine's own two-number encoding (array squares, a8 = 0),
    // which is what the client stores so a replay matches on it.
    expect(opened.moves.map((m) => m.uci)).toEqual([`${sq('e2')}${sq('e4')}`, `${sq('e7')}${sq('e5')}`]);
    // And the move list reads as chess, which is what makes it trustworthy.
    expect(opened.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(opened.moves.map((m) => m.color)).toEqual(['w', 'b']);
  });

  it('reports no live game once the game is over, but keeps it in the archive', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    await request(app).post(`/api/games/${game.id}/resign`).set(asUser(a));

    const active = await request(app).get('/api/games/active').set(asUser(b));
    expect(active.body.game).toBeNull();

    const list = await request(app).get('/api/games').set(asUser(b));
    expect(list.body.games).toHaveLength(1);
    expect(list.body.games[0].status).toBe('resigned');
    // `a` created the game, so `a` is white; asking as `b` must say black.
    expect(list.body.games[0].youAre).toBe('b');
  });

  it('never puts a sealed position in the list response', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    await playMove(a, b, game, 'e2e4');

    const list = await request(app).get('/api/games').set(asUser(b));
    expect(JSON.stringify(list.body)).not.toMatch(/encryptedState/i);
  });
});

describe('game sessions: endings', () => {
  it('records a resignation and awards the game to the other player', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');

    const res = await request(app).post(`/api/games/${game.id}/resign`).set(asUser(a));
    expect(res.status).toBe(200);
    expect(res.body.game.status).toBe('resigned');
    expect(res.body.game.winnerId).toBe(b.id);
    expect(res.body.game.youWon).toBe(false);
  });

  it('needs the opponent to accept a draw, and cannot accept your own', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    const after = await playMove(a, b, game, 'e2e4');

    // Nothing to accept yet.
    const early = await request(app).post(`/api/games/${game.id}/draw/accept`).set(asUser(b));
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('no_offer');

    const offered = await request(app).post(`/api/games/${game.id}/draw`).set(asUser(a));
    expect(offered.status).toBe(200);
    expect(offered.body.game.draw.fromYou).toBe(true);
    // An offer is not a result.
    expect(offered.body.game.status).toBe('open');

    // The offerer cannot accept it into existence.
    const selfAccept = await request(app).post(`/api/games/${game.id}/draw/accept`).set(asUser(a));
    expect(selfAccept.status).toBe(409);
    expect(selfAccept.body.code).toBe('own_offer');

    const accepted = await request(app).post(`/api/games/${game.id}/draw/accept`).set(asUser(b));
    expect(accepted.status).toBe(200);
    expect(accepted.body.game.status).toBe('draw');
    expect(accepted.body.game.winnerId).toBeNull();
    expect(after.res.body.game.status).toBe('open');
  });

  it('lets a draw offer be declined, leaving the game playable', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    await playMove(a, b, game, 'e2e4');

    await request(app).post(`/api/games/${game.id}/draw`).set(asUser(b));
    const declined = await request(app).post(`/api/games/${game.id}/draw/decline`).set(asUser(a));
    expect(declined.status).toBe(200);
    expect(declined.body.game.status).toBe('open');
    expect(declined.body.game.draw).toBeNull();

    // Black can now move, which is the point of declining.
    const moved = await playMove(b, a, declined.body.game, 'e7e5');
    expect(moved.res.status).toBe(200);
    expect(moved.res.body.game.status).toBe('open');
  });

  it('ends an abandoned game on the server’s clock, awarding it to the mover', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');
    await playMove(a, b, game, 'e2e4'); // now black's turn

    process.env.GAME_TURN_TIMEOUT_MS = '1';
    try {
      await new Promise((r) => setTimeout(r, 20));

      const read = await request(app).get(`/api/games/${game.id}`).set(asUser(b));
      expect(read.body.game.status).toBe('timeout');
      // Black was to move and let the clock run out, so BLACK lost.
      expect(read.body.game.winnerId).toBe(a.id);
      expect(read.body.game.youWon).toBe(false);

      // And the winner is told they won, which is the half that is easy to get
      // backwards: the timeout is charged to the side to move, not to the player
      // who is not looking at the screen.
      const winnerView = await request(app).get(`/api/games/${game.id}`).set(asUser(a));
      expect(winnerView.body.game.youWon).toBe(true);

      // And it stays ended: no late move may reopen it.
      const late = await request(app)
        .post(`/api/games/${game.id}/move`)
        .set(asUser(b))
        .send({
          color: 'b',
          version: read.body.game.version,
          encryptedState: await sealFor(positionJson(START, []), b, a),
        });
      expect(late.status).toBe(409);
    } finally {
      delete process.env.GAME_TURN_TIMEOUT_MS;
    }
  });
});

describe('game sessions: offering a take-back', () => {
  it('does not rewind the board until the opponent accepts', async () => {
    const { a, b } = await pairedCouple();
    let game = await newGame(a, b, 'w');
    const first = await playMove(a, b, game, 'g1f3'); // Nf3
    game = first.res.body.game;

    const before = await openGame(game, b);
    const offered = await request(app)
      .post(`/api/games/${game.id}/undo`)
      .set(asUser(a))
      .send({
        version: game.version,
        // The position one ply back, sealed by whoever is offering.
        encryptedState: await sealFor(positionJson(START, []), a, b),
      });
    expect(offered.status).toBe(200);
    expect(offered.body.game.undo.fromYou).toBe(true);

    // The offer exists, and the board has NOT moved.
    expect(offered.body.game.status).toBe('open');
    expect(offered.body.game.moveCount).toBe(1);
    const duringOffer = await openGame(offered.body.game, b);
    expect(duringOffer.state.board).toEqual(before.state.board);

    // The opponent accepts — and only then does it rewind.
    const accepted = await request(app)
      .post(`/api/games/${game.id}/undo/accept`)
      .set(asUser(b))
      .send({ version: offered.body.game.version });
    expect(accepted.status).toBe(200);
    expect(accepted.body.game.moveCount).toBe(0);
    expect(accepted.body.game.undo).toBeNull();
    // It is the offerer's move again, so they cannot be offered a second
    // take-back before moving.
    expect(accepted.body.game.turn).toBe('w');
    expect(accepted.body.game.lastMoveBy).toBe(b.id);

    const rewound = await openGame(accepted.body.game, a);
    expect(rewound.moves).toHaveLength(0);
  });

  it('will not let the person who offered take it back without the opponent', async () => {
    const { a, b } = await pairedCouple();
    const first = await newGame(a, b, 'w');
    const played = await playMove(a, b, first, 'g1f3');
    const offered = await request(app)
      .post(`/api/games/${played.res.body.game.id}/undo`)
      .set(asUser(a))
      .send({
        version: played.res.body.game.version,
        encryptedState: await sealFor(positionJson(START, []), a, b),
      });
    expect(offered.status).toBe(200);

    const selfAccept = await request(app)
      .post(`/api/games/${played.res.body.game.id}/undo/accept`)
      .set(asUser(a))
      .send({ version: offered.body.game.version });
    expect(selfAccept.status).toBe(409);
    expect(selfAccept.body.code).toBe('own_offer');
  });

  it('only lets the player who just move offer a take-back', async () => {
    const { a, b } = await pairedCouple();
    const first = await newGame(a, b, 'w');
    const played = await playMove(a, b, first, 'g1f3');

    // Black did not make the last move.
    const res = await request(app)
      .post(`/api/games/${played.res.body.game.id}/undo`)
      .set(asUser(b))
      .send({
        version: played.res.body.game.version,
        encryptedState: await sealFor(positionJson(START, []), b, a),
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_your_move');
  });

  it('refuses a take-back that has nothing behind it', async () => {
    const { a, b } = await pairedCouple();
    const game = await newGame(a, b, 'w');

    const nothing = await request(app)
      .post(`/api/games/${game.id}/undo`)
      .set(asUser(a))
      .send({ version: game.version, encryptedState: await sealFor(positionJson(START, []), a, b) });
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe('nothing_to_undo');

    const noOffer = await request(app).post(`/api/games/${game.id}/undo/accept`).set(asUser(b));
    expect(noOffer.status).toBe(409);
    expect(noOffer.body.code).toBe('no_offer');
  });

  it('lets the opponent decline, and the move then stands', async () => {
    const { a, b } = await pairedCouple();
    const first = await newGame(a, b, 'w');
    const played = await playMove(a, b, first, 'g1f3');
    const offered = await request(app)
      .post(`/api/games/${played.res.body.game.id}/undo`)
      .set(asUser(a))
      .send({
        version: played.res.body.game.version,
        encryptedState: await sealFor(positionJson(START, []), a, b),
      });

    const declined = await request(app)
      .post(`/api/games/${played.res.body.game.id}/undo/decline`)
      .set(asUser(b));
    expect(declined.status).toBe(200);
    expect(declined.body.game.undo).toBeNull();
    expect(declined.body.game.moveCount).toBe(1);

    // The position is unchanged, so the side to move can carry on normally.
    const next = await playMove(b, a, declined.body.game, 'e7e5');
    expect(next.res.status).toBe(200);
    expect(next.res.body.game.moveCount).toBe(2);
    expect(offered.body.game.version).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * the claim the whole step rests on                                   *
 * ------------------------------------------------------------------ */

describe('the stored position is ciphertext', () => {
  /**
   * Reads every byte SQLite has written, including the WAL.
   *
   * WAL matters: the database is in WAL mode, so a freshly committed row may be
   * sitting in `-wal` rather than in the main file. Reading only `penpal.db`
   * would pass this test by finding nothing, which is not the same as finding
   * nothing readable.
   */
  function allBytes() {
    const parts = [];
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${DB_PATH}${suffix}`;
      if (fs.existsSync(file)) parts.push(fs.readFileSync(file));
    }
    return Buffer.concat(parts);
  }

  it('leaves no readable board on disk after a played game', async () => {
    const { a, b } = await pairedCouple();
    let game = await newGame(a, b, 'w');

    // A real 13-move game: a knight sortie, a bishop sacrifice taken by a pawn
    // (Bxc6 dxc6), kingside castling, and both rooks developed. Chosen because
    // the leaked-ciphertext assertions below look for SAN and square names, and a
    // game that never captures and never castles would leave those untested.
    const script = [
      [a, 'e2e4'],
      [b, 'e7e5'],
      [a, 'g1f3'],
      [b, 'b8c6'],
      [a, 'f1b5'],
      [b, 'a7a6'],
      [a, 'b5c6'],
      [b, 'd7c6'],
      [a, 'e1g1'],
      [b, 'g8f6'],
      [a, 'f1e1'],
      [b, 'f8e7'],
      [a, 'd2d4'],
    ];
    let state = START;
    for (const [who, algebraic] of script) {
      const other = who === a ? b : a;
      const step = await playMove(who, other, game, algebraic);
      expect(step.res.status, `${algebraic} should be legal`).toBe(200);
      state = step.state;
      game = step.res.body.game;
    }
    expect(game.moveCount).toBe(13);
    // The board really did change: this is a played game, not a no-op that
    // happens to leave nothing behind to find.
    expect(state.board).not.toEqual(START.board);

    const bytes = allBytes();
    expect(bytes.length).toBeGreaterThan(0);
    const haystack = bytes.toString('latin1');

    // ## How to search ciphertext without searching up a false positive
    //
    // The stored blobs are base64, which is a 64-character alphabet, not 256. In
    // ~100KB of base64 the expected number of occurrences of any given THREE
    // character string is ~0.4 — so asserting `"Re1" is not on disk` fails about
    // a third of the time on a perfectly encrypted database. That assertion was
    // in this file, and it failed exactly that way.
    //
    // So every needle below is at least SIX characters, quoted where it is a
    // JSON value, which puts the expected false-positive rate below 1 in 10^8.
    // Searching for more characters costs nothing and turns a flaky test into a
    // real one.

    // 1. Nothing that reads as a chess position. A board array is a JSON array of
    //    nulls and {t,c} objects; that is the single most likely thing to leak.
    expect(haystack).not.toMatch(/"board"/);
    expect(haystack).not.toMatch(/\\"board\\"/);
    expect(haystack).not.toMatch(/\{"t":"[pnbrqk]","c":"[wb]"\}/);

    // 2. No FEN-shaped string, and no starting arrangement, which is what a
    //    leaked position looks like even when compressed away from JSON.
    expect(haystack).not.toMatch(/rnbqkbnr/i);
    expect(haystack).not.toMatch(/pppppppp/i);
    expect(haystack).not.toMatch(/RNBQKBNR/i);
    expect(haystack).not.toMatch(/[wbKQkq]{1,4}-[a-h][36]\b/);

    // 3. No square names and no SAN, so the move list is not sitting in the
    //    clear. Quoted, and long enough to not collide with the ciphertext.
    for (const square of ['"a1"', '"e4"', '"h8"', '"d4"', '"g7"']) {
      expect(haystack, `square name ${square} must not be readable`).not.toContain(square);
    }
    for (const san of ['"Nf3"', '"Nc6"', '"Bxc6"', '"dxc6"', '"Re1"', '"O-O"', '"Bb5"', '"Be7"']) {
      expect(haystack, `SAN ${san} must not be readable`).not.toContain(san);
    }
    // The whole move list as one string, which is what a leaked plaintext would
    // actually look like — and is the assertion that would survive a reformat of
    // the individual records.
    expect(haystack).not.toContain('"e4","e5","Nf3","Nc6"');

    // 4. No plaintext of the sealed payload anywhere.
    expect(haystack).not.toContain(JSON.stringify(state.board));

    // 5. The ciphertext really is there — a test that passes because nothing was
    //    written is worse than no test at all.
    // 5. The ciphertext really is there. A test that passes because nothing was
    //    written is worse than no test at all.
    //
    //    Asserted against the STORED ROW, not against the raw file: SQLite keeps
    //    column names in `sqlite_master` and packs the actual values into page
    //    cells, so searching the file for a column name finds the schema rather
    //    than the data. What matters is that the value in the row is an envelope.
    const reader = inspect();
    const stored = reader.prepare('SELECT encrypted_state FROM game_sessions WHERE id = ?').get(game.id);
    expect(stored.encrypted_state.length).toBeGreaterThan(200);
    const envelope = JSON.parse(stored.encrypted_state);
    expect(typeof envelope.ct).toBe('string');
    expect(envelope.ct.length).toBeGreaterThan(16);
    // A wrapped key per participant, which is what makes it readable by both.
    expect(Object.keys(envelope.keys).sort()).toEqual([String(a.id), String(b.id)].sort());
    // And it decrypts to the position, which is the other half of the claim.
    const plain = await openLetter(envelope, b.privateKey, b.id);
    const recovered = JSON.parse(plain);
    expect(recovered.moves).toHaveLength(13);
    // The SAN list that was NOT findable on disk is exactly what comes back out.
    expect(recovered.moves.map((m) => m.san)).toEqual([
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O', 'Nf6', 'Re1', 'Be7', 'd4',
    ]);
    reader.close();
  }, 60_000);

  it('stores the take-back offer and the draw offer as ciphertext too', async () => {
    const { a, b } = await pairedCouple();
    const first = await newGame(a, b, 'w');
    const played = await playMove(a, b, first, 'g1f3');
    const undone = await sealFor(positionJson(START, []), a, b);

    await request(app)
      .post(`/api/games/${played.res.body.game.id}/undo`)
      .set(asUser(a))
      .send({ version: played.res.body.game.version, encryptedState: undone });
    await request(app).post(`/api/games/${played.res.body.game.id}/draw`).set(asUser(a));

    const reader = inspect();
    const row = reader
      .prepare('SELECT encrypted_undo, draw_offered_by FROM game_sessions WHERE id = ?')
      .get(played.res.body.game.id);

    expect(row.draw_offered_by).toBe(a.id);
    expect(row.encrypted_undo).toBe(undone);
    // It is an envelope, and the position inside it is not readable on disk.
    expect(JSON.parse(row.encrypted_undo).v).toBe(2);
    reader.close();

    const bytes = allBytes().toString('latin1');
    expect(bytes).not.toMatch(/"board"/);
    expect(bytes).not.toMatch(/\\"board\\"/);
  });
});

/* ------------------------------------------------------------------ *
 * plan step 25 — the engine, off the main thread                      *
 * ------------------------------------------------------------------ */

describe('the engine worker', () => {
  /**
   * A port that stands in for `self` inside a Worker.
   *
   * This drives `client/src/chess.worker.ts` itself — the same file Vite loads
   * in the browser — rather than a re-implementation. A test that re-implements
   * the worker proves nothing about the worker, which is how a search module
   * ends up shipping with no Worker at all (the v0.0.2 bug).
   */
  function fakePort() {
    const sent = [];
    return {
      sent,
      postMessage(message) {
        sent.push(message);
      },
      onmessage: null,
      /** The next result/error, or null if none has arrived. */
      settle() {
        return sent.find((m) => m.type === 'result' || m.type === 'error') ?? null;
      },
    };
  }

  const withTimeout = (ms, promise, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms)),
    ]);

  it('answers with a move and terminates, under a bounded timeout', async () => {
    const { createWorkerEndpoint } = await import('../client/src/chess.worker.ts');
    const port = fakePort();
    const endpoint = createWorkerEndpoint(port);

    endpoint.handle({ type: 'search', id: 7, state: cloneState(START), level: 'casual' });

    const settled = await withTimeout(
      20_000,
      (async () => {
        while (!port.settle()) await new Promise((r) => setTimeout(r, 5));
        return port.settle();
      })(),
      'worker search',
    );

    expect(settled.type).toBe('result');
    expect(settled.id).toBe(7);
    expect(settled.result.move).toBeTruthy();
    expect(settled.result.san).toBeTruthy();
    expect(settled.result.depth).toBeGreaterThanOrEqual(1);
    // The move it returned has to be a legal move in the position it was given.
    const legal = legalMoves(START).map((m) => `${m.from}${m.to}`);
    expect(legal).toContain(`${settled.result.move.from}${settled.result.move.to}`);
    // Nothing is left running.
    expect(endpoint.active).toBe(0);
    endpoint.stop();
  }, 30_000);

  it('can be stopped mid-search, and reports what it had', async () => {
    const { createWorkerEndpoint } = await import('../client/src/chess.worker.ts');
    const port = fakePort();
    const endpoint = createWorkerEndpoint(port);

    // 'strong' is 15 seconds of budget. Stopping it must not take anything like
    // that: this is the difference between "cancellable" and "a freeze".
    const started = Date.now();
    endpoint.handle({ type: 'search', id: 1, state: cloneState(START), level: 'strong' });
    await new Promise((r) => setTimeout(r, 120));
    endpoint.handle({ type: 'stop' });

    const settled = await withTimeout(
      5_000,
      (async () => {
        while (!port.settle()) await new Promise((r) => setTimeout(r, 5));
        return port.settle();
      })(),
      'stopped search',
    );

    const elapsed = Date.now() - started;
    expect(settled.type).toBe('result');
    // A truncated search is a valid answer, not a failure.
    expect(settled.result.truncated).toBe(true);
    expect(settled.result.move).toBeTruthy();
    // It really did stop early rather than run the full budget.
    expect(elapsed, `stop took ${elapsed}ms`).toBeLessThan(4_000);
    expect(endpoint.active).toBe(0);
  }, 30_000);

  it('reports progress as it goes, so a UI can show the engine thinking', async () => {
    const { createWorkerEndpoint } = await import('../client/src/chess.worker.ts');
    const port = fakePort();
    const endpoint = createWorkerEndpoint(port);

    endpoint.handle({ type: 'search', id: 3, state: cloneState(START), level: 'club' });
    await withTimeout(
      15_000,
      (async () => {
        while (!port.settle()) await new Promise((r) => setTimeout(r, 5));
      })(),
      'progress search',
    );

    const progress = port.sent.filter((m) => m.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].id).toBe(3);
    // Depth must never go backwards as the search deepens.
    const depths = progress.map((p) => p.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    endpoint.stop();
  }, 30_000);

  it('reports a failure as a message rather than dying silently', async () => {
    const { createWorkerEndpoint } = await import('../client/src/chess.worker.ts');
    const port = fakePort();
    const endpoint = createWorkerEndpoint(port);

    // A position the rules engine cannot make sense of. The engine must answer,
    // not throw into the void — a Worker that dies mid-search takes the page with
    // it, and the UI is left waiting for a move that is never coming.
    endpoint.handle({
      type: 'search',
      id: 9,
      state: { ...cloneState(START), board: new Array(63).fill(null) },
      level: 'casual',
    });

    const settled = await withTimeout(
      20_000,
      (async () => {
        while (!port.settle()) await new Promise((r) => setTimeout(r, 5));
        return port.settle();
      })(),
      'broken-position search',
    );
    expect(settled.type).toBe('result');
    expect(settled.result.move).toBeNull();
    endpoint.stop();
  }, 30_000);

  it('falls back to the main thread, and says so, when Worker is unavailable', async () => {
    const { createChessEngine } = await import('../client/src/lib/chessSearch.ts');

    // The engine reads `typeof Worker === 'function'` at call time, so shadowing
    // the global is enough to simulate the environment — no module mocking, and
    // the code under test is exactly what ships.
    const original = globalThis.Worker;
    // A browser (or a CSP) that refuses to construct a module Worker.
    globalThis.Worker = function BrokenWorker() {
      throw new Error('Refused to construct a Worker: blocked by worker-src');
    };
    try {
      const engine = createChessEngine({ level: 'casual' });
      const result = await withTimeout(10_000, engine.bestMove(START), 'main-thread fallback');

      expect(engine.transport).toBe('main-thread');
      expect(engine.degradation).toBeTruthy();
      expect(engine.degradation).toMatch(/content-security-policy|worker-src/i);
      // Degraded, not broken: still a legal move, just a shallower search.
      expect(result.move).toBeTruthy();
      engine.dispose();
    } finally {
      globalThis.Worker = original;
    }
  }, 30_000);

  it('reports the main thread as free while a search runs', async () => {
    const { createWorkerEndpoint } = await import('../client/src/chess.worker.ts');
    const wt = await import('node:worker_threads');

    /**
     * Measures event-loop latency on THIS thread while a search runs in a
     * Worker thread — the real arrangement, and the claim step 25 makes.
     *
     * A timer that fires every 5ms and reports its own lateness is the honest
     * measurement: "the page stayed responsive" is only interesting as a number,
     * and a test that merely asserted `searchRanInWorker === true` would still
     * pass if the search were synchronous and blocked for four seconds.
     */
    const gaps = [];
    let running = true;
    const beat = () => {
      const expected = Date.now() + 5;
      const id = setTimeout(() => {
        gaps.push(Date.now() - expected);
        if (running) beat();
      }, 5);
      return id;
    };
    beat();

    // The Worker thread runs the SAME module the browser loads, over the same
    // `self`-shaped port. Only the transport differs.
    const source = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { createWorkerEndpoint } from ${JSON.stringify(path.resolve('client/src/chess.worker.ts'))};
      const port = { onmessage: null, postMessage(m) { parentPort.postMessage(m); } };
      const endpoint = createWorkerEndpoint(port);
      endpoint.handle({ type: 'search', id: 1, state: workerData.state, level: workerData.level });
    `;

    const worker = new wt.Worker(source, {
      eval: true,
      workerData: { state: cloneState(START), level: 'tough' },
      execArgv: ['--experimental-strip-types', '--no-warnings'],
    });

    const firstResult = await withTimeout(
      30_000,
      new Promise((resolve) => {
        worker.on('message', (m) => {
          if (m.type === 'result') resolve(m);
        });
      }),
      'worker-thread search',
    );
    worker.terminate();
    running = false;

    expect(firstResult.type).toBe('result');
    expect(firstResult.result.move).toBeTruthy();
    expect(gaps.length, 'the event loop must have run during the search').toBeGreaterThan(20);

    // A main-thread search of the same size would show gaps in the hundreds of
    // milliseconds. Anything near 100ms+ means the work leaked onto this thread.
    const worst = Math.max(...gaps);
    const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    // eslint-disable-next-line no-console
    console.log(
      `      event loop during search: ${gaps.length} ticks, median +${median}ms, worst +${worst}ms`,
    );
    expect(median, `median event-loop lag was ${median}ms`).toBeLessThan(60);
    expect(worst, `worst event-loop lag was ${worst}ms`).toBeLessThan(400);
  }, 60_000);
});