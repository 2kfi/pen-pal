/**
 * The chess page's data layer, driven against the real server.
 *
 * ## Why there is no mock in here
 *
 * A position in this file is sealed by `sealLetter` — the same function the
 * browser calls, with the same RSA-OAEP key wrapping and the same AAD — stored
 * by `server/repos/games.js` in a real SQLite file, and opened again by
 * `openLetter` with a real private key that had to be unlocked with a password
 * first. The HTTP layer is the real Express router on a real socket; only
 * `fetch` is redirected at it.
 *
 * That matters because every claim being tested is a claim about a seam between
 * two modules that were written separately and had never met:
 *
 *   - a position survives encrypt → store → decrypt byte for byte
 *   - it is your turn only, and the refusal comes from the server
 *   - a take-back needs the OTHER player to accept, and declining changes nothing
 *   - reconnecting after a refresh yields the same position
 *
 * A store test with a mocked API would pass with both modules subtly wrong.
 *
 * ## One store, two people
 *
 * `useGames` is a module singleton, so both "browsers" share it. That is not a
 * shortcut: the store reads who you are and which private key is resident at
 * call time, so `become(player)` is exactly what switching machines does, and
 * `reset()` followed by `load()` is exactly what a refresh does.
 *
 * Tests run in order against one database and one game, and each one says which
 * ply it is arriving at, because a suite about state transitions cannot shuffle
 * itself.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Move } from '../lib/chessEngine';
import type { GameSession, SealedMove } from '../lib/chessGames';

/**
 * Node's own modules are reached through `require` rather than imported.
 *
 * This project is a browser app: its tsconfig has no Node types, so `import
 * 'node:fs'` would be an untyped module in a file that is otherwise fully
 * checked. Going through `createRequire` keeps the type checker on the code that
 * matters — the store, the client modules and the assertions — instead of
 * switching it off for the whole file.
 */
interface NodeRequire {
  (id: string): any;
}

const require: NodeRequire = (await import('node:module' as string)).createRequire(import.meta.url);
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const nodeEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
  .env;

/* ------------------------------------------------------------------ *
 * the server, stood up before anything else is imported               *
 * ------------------------------------------------------------------ */

const DATA_DIR: string = mkdtempSync(join(tmpdir(), 'penpal-games-ui-'));
nodeEnv.NODE_ENV = 'test';
nodeEnv.DATA_DIR = DATA_DIR;
nodeEnv.JWT_SECRET = 'games-ui-test-secret-not-for-production-1234567890';
// The clock is the server's. Pinned rather than defaulted so that a machine
// with an odd clock cannot end a game in the middle of a test.
nodeEnv.GAME_TURN_TIMEOUT_MS = String(72 * 60 * 60 * 1000);

interface DbHandle {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, string | number | null>;
  };
}

const { initDB, getDb, closeDB } = require('../../../server/db.js') as {
  initDB: () => void;
  getDb: () => DbHandle;
  closeDB: () => void;
};
initDB();
const db = getDb();

const gameRoutes = require('../../../server/routes/games.js') as () => unknown;
const { signAccessToken } = require('../../../server/lib/auth.js') as {
  signAccessToken: (u: { id: number; username: string; pid: string }) => string;
};

const { exportKey, generateKeyPair, sealLetter, wrapPrivateKey } = await import('../lib/crypto');
const { gamesApi, newLocalGame, openGame, sealPayload, verifySealedGame } = await import('../lib/chessGames');
const { legalMoves, square } = await import('../lib/chessEngine');
const { ApiError } = await import('../lib/api');
const { setAccessToken } = await import('../lib/session');
const { activeKey, useVault } = await import('../lib/vault');
const { useAuth } = await import('./auth');
const { useGames } = await import('./games');
const { usePairing } = await import('./pairing');
const { stateLine } = await import('../pages/PenPalChess');

/* ------------------------------------------------------------------ *
 * the two of them                                                     *
 * ------------------------------------------------------------------ */

const PASSWORD = 'correct horse battery staple';

interface Player {
  id: number;
  username: string;
  friendlyName: string;
  pid: string;
  token: string;
  publicJwk: JsonWebKey;
  /** The password-wrapped private key, which is all the server ever holds. */
  wrappedKey: object;
}

let counter = 0;

async function makePlayer(friendlyName: string): Promise<Player> {
  counter += 1;
  const keys = await generateKeyPair();
  const publicJwk = await exportKey(keys.publicKey);
  const wrappedKey = await wrapPrivateKey(await exportKey(keys.privateKey), PASSWORD);

  const username = `pp${counter}_${Math.random().toString(36).slice(2, 8)}`;
  const pid = `PID${counter}${Math.random().toString(36).slice(2, 6).toUpperCase()}`.slice(0, 16);
  db.prepare(
    `INSERT INTO users (username, friendly_name, email, password_hash, public_key,
                        encrypted_private_key, pid, profile_data)
     VALUES (?, ?, ?, 'not-a-real-hash', ?, ?, ?, '{}')`,
  ).run(username, friendlyName, `${username}@test.local`, JSON.stringify(publicJwk), JSON.stringify(wrappedKey), pid);

  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  const id = Number(row.id);
  return {
    id,
    username,
    friendlyName,
    pid,
    token: signAccessToken({ id, username, pid }),
    publicJwk,
    wrappedKey,
  };
}

let alice: Player;
let bob: Player;

/**
 * Become one of the two: the identity the store reads, the partner it seals to,
 * the key it opens with, the bearer token the API sends. Everything a browser
 * restart changes, and nothing else. The unlock goes through the real
 * PBKDF2-wrapped private key rather than a shortcut past it.
 */
async function become(player: Player, other: Player) {
  setAccessToken(player.token);
  useAuth.setState({
    authenticated: true,
    restoring: false,
    user: {
      id: player.id,
      username: player.username,
      email: `${player.username}@test.local`,
      pid: player.pid,
      friendly_name: player.friendlyName,
      bio: null,
      avatar_url: null,
      publicKey: JSON.stringify(player.publicJwk),
      encryptedPrivateKey: JSON.stringify(player.wrappedKey),
    },
  });
  usePairing.setState({
    partner: {
      id: other.id,
      username: other.username,
      friendly_name: other.friendlyName,
      pid: other.pid,
      publicKey: JSON.stringify(other.publicJwk),
    },
  });
  await useVault.getState().unlock(player.wrappedKey as never, PASSWORD);
  expect(activeKey()).not.toBeNull();
}

/** The server's own row, read through its own handle. */
function storedRow(gameId: number): Record<string, string | number | null> {
  return db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(gameId);
}

/**
 * "e2e4" → engine indices, through the engine's own `square()`.
 *
 * Written out by hand, these are the numbers a test gets wrong while still
 * asserting confidently, so they are never written out by hand.
 */
function uciOf(algebraic: string): { from: number; to: number; promotion?: 'q' | 'r' | 'b' | 'n' } {
  const at = (name: string) => square(name.charCodeAt(0) - 97, 8 - Number(name[1]));
  return {
    from: at(algebraic.slice(0, 2)),
    to: at(algebraic.slice(2, 4)),
    promotion: algebraic.length > 4 ? (algebraic[4] as 'q' | 'r' | 'b' | 'n') : undefined,
  };
}

/** The legal move for an algebraic pair, resolved against the open position. */
function legalFor(algebraic: string): Move {
  const { position } = useGames.getState();
  if (!position) throw new Error('no position is open');
  const { from, to, promotion } = uciOf(algebraic);
  const found = legalMoves(position).find(
    (m) => m.from === from && m.to === to && (m.promotion ?? undefined) === promotion,
  );
  if (!found) throw new Error(`${algebraic} is not legal in the open position`);
  return found;
}

/** Seals a position between two players exactly as the store does. */
async function sealPosition(
  sender: Player,
  recipient: Player,
  state: GameState,
  moves: SealedMove[],
): Promise<string> {
  const envelope = await sealLetter(JSON.stringify(sealPayload(state, moves)), {
    senderId: sender.id,
    recipientId: recipient.id,
    senderPublicKey: sender.publicJwk,
    recipientPublicKey: recipient.publicJwk,
    sentAt: new Date().toISOString(),
  });
  return JSON.stringify(envelope);
}

const sans = () => useGames.getState().moves.map((m) => m.san);

interface Listener {
  close(cb: (...args: any[]) => void): void;
  once(event: string, cb: () => void): void;
  address(): { port: number } | null;
}

/** The two shapes the stubbed endpoints are written against. */
interface StubRequest {
  headers: Record<string, string | undefined>;
}
interface StubResponse {
  json(body: unknown): void;
}

let server: Listener;
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  alice = await makePlayer('Sam');
  bob = await makePlayer('Robin');
  db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(alice.id, bob.id);
  db.prepare('INSERT INTO pairs (user_id, partner_id) VALUES (?, ?)').run(bob.id, alice.id);

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // The games router is mounted for real. These two exist so the pairing
  // store's refresh is exercised rather than quietly failing and leaving a stale
  // partner behind — the store calls them on every load.
  const whoami = (req: StubRequest) =>
    [alice, bob].find((p) => req.headers.authorization === `Bearer ${p.token}`);
  app.get('/api/pairing/status', (req: StubRequest, res: StubResponse) => {
    const other = whoami(req) === alice ? bob : alice;
    res.json({
      incoming: [],
      outgoing: [],
      partner: { ...other, publicKey: JSON.stringify(other.publicJwk) },
    });
  });
  app.get('/api/me', (req: StubRequest, res: StubResponse) => {
    const me = whoami(req)!;
    res.json({ id: me.id, username: me.username, pid: me.pid });
  });

  app.use('/api/games', gameRoutes());

  server = app.listen(0) as Listener;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address()!;

  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    realFetch(new URL(String(input), `http://127.0.0.1:${port}`), init)) as typeof fetch;
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => {
    server.close(resolve);
  });
  closeDB();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * ply 0 — a board is sealed and stored                                *
 * ------------------------------------------------------------------ */

describe('a position survives the round trip', () => {
  it('is sealed in the browser, stored as an envelope, and opens to the same bytes', async () => {
    await become(alice, bob);
    await useGames.getState().create('w');

    const { session, position } = useGames.getState();
    expect(session).not.toBeNull();
    expect(position).not.toBeNull();
    expect(session!.youAre).toBe('w');
    expect(session!.turn).toBe('w');

    // The plaintext, byte for byte, exactly as it was before sealing.
    const expected = JSON.stringify(sealPayload(newLocalGame(), []));

    expect(JSON.stringify(await openGame(session!.encryptedState, activeKey()!, alice.id))).toBe(expected);

    // The other player opens the SAME stored envelope and gets the same bytes.
    // A position only one side could read would break the moment that side
    // refreshed, which is the whole promise.
    await become(bob, alice);
    expect(JSON.stringify(await openGame(session!.encryptedState, activeKey()!, bob.id))).toBe(expected);
    await become(alice, bob);
  });

  it('stores an envelope and nothing that describes the board', async () => {
    const id = useGames.getState().session!.id;
    const row = storedRow(id);

    // Structural, rather than a substring hunt: the stored value parses as a
    // letter envelope and has no field a board could be hiding in.
    const envelope = JSON.parse(String(row.encrypted_state));
    expect(Object.keys(envelope).sort()).toEqual(['ct', 'iv', 'keys', 'recipientId', 'senderId', 'sentAt', 'v']);
    expect(Object.keys(envelope.keys).sort()).toEqual([String(alice.id), String(bob.id)].sort());

    // Then the words of the payload, at seven characters or more. Shorter
    // needles hit base64 by chance often enough to make the assertion a coin
    // flip in the passing direction.
    for (const needle of ['halfmove', 'fullmove', 'castling', '"board"', '"moves"']) {
      expect(String(row.encrypted_state)).not.toContain(needle);
    }
    // And no other column of the row carries it either.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toContain('halfmove');
    }
  });
});

/* ------------------------------------------------------------------ *
 * ply 1 — one move, then the turn belongs to somebody else             *
 * ------------------------------------------------------------------ */

describe('it is your turn only', () => {
  it('refuses a second move from the player who has just moved', async () => {
    await useGames.getState().play(legalFor('e2e4'));

    const first = useGames.getState();
    expect(sans()).toEqual(['e4']);
    expect(first.session!.turn).toBe('b');
    expect(first.session!.lastMoveBy).toBe(alice.id);

    // The page refuses it before a byte is sent.
    await useGames.getState().play(legalFor('d7d5'));
    expect(useGames.getState().error).toMatch(/black is to move/i);
    expect(sans()).toEqual(['e4']);
  });

  it('is refused by the server as well, not only by the store', async () => {
    const { session, position, moves } = useGames.getState();

    // A well-formed envelope claiming a second consecutive white move.
    const forged = await sealPosition(alice, bob, position!, moves);

    let refused: unknown = null;
    try {
      await gamesApi.move(session!.id, {
        color: 'w',
        version: session!.version,
        encryptedState: forged,
      });
    } catch (e) {
      refused = e;
    }

    expect(refused).toBeInstanceOf(ApiError);
    const refusal = refused as { status: number; message: string };
    expect(refusal.status).toBe(409);
    expect(refusal.message).toMatch(/already moved/i);
    expect(storedRow(session!.id).encrypted_state).toBe(session!.encryptedState);
  });

  it('lets the other player answer, and hands the turn straight back', async () => {
    await become(bob, alice);
    useGames.getState().reset();
    await useGames.getState().load();
    expect(useGames.getState().session!.youAre).toBe('b');

    await useGames.getState().play(legalFor('d7d5'));

    expect(sans()).toEqual(['e4', 'd5']);
    expect(useGames.getState().session!.turn).toBe('w');
    expect(useGames.getState().session!.moveCount).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * ply 2 — a take-back is a request                                    *
 * ------------------------------------------------------------------ */

describe('a take-back needs the other player to accept it', () => {
  it('does not move the board, and declining leaves the move standing', async () => {
    expect(useGames.getState().session!.lastMoveBy).toBe(bob.id);

    await useGames.getState().offerUndo();
    const offered = useGames.getState();
    expect(offered.session!.undo).toMatchObject({ offeredBy: bob.id, fromYou: true });
    expect(offered.notice).toMatch(/only if they accept/i);
    // Nothing on the board moved.
    expect(sans()).toEqual(['e4', 'd5']);

    const row = storedRow(offered.session!.id);
    expect(row.undo_requested_by).toBe(bob.id);
    expect(row.encrypted_undo).toBeTruthy();
    // The rolled-back position waits in its own column. The live position is
    // untouched, so a pending offer cannot change what either player is looking
    // at before it is accepted.
    expect(row.encrypted_state).toBe(offered.session!.encryptedState);

    await become(alice, bob);
    useGames.getState().reset();
    await useGames.getState().load();
    expect(useGames.getState().session!.undo).toMatchObject({ offeredBy: bob.id, fromYou: false });

    const beforeDecline = useGames.getState().session!.encryptedState;
    await useGames.getState().declineUndo();

    const declined = useGames.getState();
    expect(sans()).toEqual(['e4', 'd5']);
    expect(declined.session!.status).toBe('open');
    expect(declined.session!.undo).toBeNull();
    expect(storedRow(declined.session!.id).encrypted_state).toBe(beforeDecline);
    expect(storedRow(declined.session!.id).encrypted_undo).toBeNull();
  });

  it('rewinds only when the other player accepts', async () => {
    // Alice is to move, so she has to play before she has anything to take back.
    await useGames.getState().play(legalFor('b1c3'));
    const id = useGames.getState().session!.id;
    const afterMove = useGames.getState().session!.encryptedState;
    expect(sans()).toEqual(['e4', 'd5', 'Nc3']);

    await useGames.getState().offerUndo();
    expect(sans()).toEqual(['e4', 'd5', 'Nc3']);
    expect(storedRow(id).encrypted_state).toBe(afterMove);

    await become(bob, alice);
    useGames.getState().reset();
    await useGames.getState().load();
    await useGames.getState().acceptUndo();

    const accepted = useGames.getState();
    expect(sans()).toEqual(['e4', 'd5']);
    expect(accepted.session!.moveCount).toBe(2);
    expect(accepted.session!.turn).toBe('w');
    expect(accepted.session!.undo).toBeNull();
    expect(storedRow(id).undo_requested_by).toBeNull();

    // The board that is drawn now is the one the partner agreed to, not a local
    // pop of a list.
    const sealed = await openGame(accepted.session!.encryptedState, activeKey()!, bob.id);
    expect(sealed.moves).toHaveLength(2);
    expect(verifySealedGame(sealed)).toBeNull();
  });

  it('will not let the offerer accept their own take-back', async () => {
    // It is Alice's turn again after the take-back, so she moves, offers, and
    // then tries to grant herself what only Bob can grant.
    await become(alice, bob);
    useGames.getState().reset();
    await useGames.getState().load();
    await useGames.getState().play(legalFor('b1c3'));
    await useGames.getState().offerUndo();

    await useGames.getState().acceptUndo();
    expect(useGames.getState().error).toMatch(/your partner has to/i);
    expect(sans()).toEqual(['e4', 'd5', 'Nc3']);
    expect(useGames.getState().session!.status).toBe('open');
  });
});

/* ------------------------------------------------------------------ *
 * ply 4 — a refresh                                                   *
 * ------------------------------------------------------------------ */

describe('reconnecting', () => {
  it('returns to the same position, for both players, from the server alone', async () => {
    await become(bob, alice);
    useGames.getState().reset();
    await useGames.getState().load();
    await useGames.getState().play(legalFor('c7c5'));
    expect(sans()).toEqual(['e4', 'd5', 'Nc3', 'c5']);

    // Alice refreshes: nothing in memory, one request, the server's row.
    await become(alice, bob);
    useGames.getState().reset();
    expect(useGames.getState().session).toBeNull();
    expect(useGames.getState().position).toBeNull();

    await useGames.getState().load();
    const reopened = useGames.getState();
    expect(reopened.session!.moveCount).toBe(4);
    expect(sans()).toEqual(['e4', 'd5', 'Nc3', 'c5']);
    expect(reopened.session!.turn).toBe('w');

    // And the position the store is drawing is exactly the one that was sealed,
    // which the rules engine can still rebuild from its own move list.
    const sealed = await openGame(reopened.session!.encryptedState, activeKey()!, alice.id);
    expect(verifySealedGame(sealed)).toBeNull();
    expect(sealed.turn).toBe('w');
    expect(sealed.moves).toHaveLength(4);
    expect(reopened.position!.board).toEqual(
      sealed.board.map((p) => (p ? { t: p.t, c: p.c } : p)),
    );

    // Bob refreshes onto the same squares from the same envelope.
    await become(bob, alice);
    useGames.getState().reset();
    await useGames.getState().load();
    expect(sans()).toEqual(['e4', 'd5', 'Nc3', 'c5']);
    expect(useGames.getState().position!.board).toEqual(reopened.position!.board);
    expect(useGames.getState().position!.turn).toBe(reopened.position!.turn);
    expect(useGames.getState().position!.fullmove).toBe(reopened.position!.fullmove);
  });

  it('reports a locked vault as an error, never as an empty board', async () => {
    useVault.getState().lock();
    useGames.getState().reset();
    await useGames.getState().load();

    expect(useGames.getState().session).toBeNull();
    expect(useGames.getState().position).toBeNull();
    expect(useGames.getState().error).toMatch(/locked/i);
  });
});

/* ------------------------------------------------------------------ *
 * what the page says, for every state a game can reach                *
 * ------------------------------------------------------------------ */

describe('the sentences', () => {
  const NOW = Date.parse('2026-10-15T12:00:00.000Z');
  const session = (over: Partial<GameSession>): GameSession =>
    ({
      id: 1,
      pairKey: '1-2',
      whiteId: alice.id,
      blackId: bob.id,
      youAre: 'w',
      turn: 'w',
      status: 'open',
      winnerId: null,
      youWon: false,
      moveCount: 4,
      lastMoveBy: bob.id,
      lastMoveAt: new Date(NOW - 2 * 86400_000).toISOString(),
      version: 5,
      encryptedState: '{}',
      undo: null,
      draw: null,
      turnDeadline: null,
      createdBy: alice.id,
      createdAt: new Date(NOW - 5 * 86400_000).toISOString(),
      updatedAt: new Date(NOW - 2 * 86400_000).toISOString(),
      closedAt: null,
      ...over,
    }) as GameSession;

  it('says nothing has arrived while it is the other player’s turn', () => {
    const line = stateLine(session({ turn: 'b' }), alice.id, 'Robin', 'Robin to move.', NOW);
    expect(line).toContain('Robin is to move.');
    // The number of days is real, taken from the last move, and the sentence
    // never claims the partner is thinking or has read anything.
    expect(line).toContain('Nothing has arrived for 2 days.');
    expect(line).not.toMatch(/thinking|seen|read/i);
  });

  it('says your move, without the wait sentence, when it is yours', () => {
    expect(stateLine(session({}), alice.id, 'Robin', '', NOW)).toBe('Your move.');
  });

  it.each([
    ['checkmate', 'Checkmate. You win.'],
    ['stalemate', 'Stalemate. A draw.'],
    ['draw', 'Agreed draw.'],
  ] as const)('names the ending %s', (status, expected) => {
    expect(stateLine(session({ status, winnerId: alice.id }), alice.id, 'Robin', '', NOW)).toBe(expected);
  });

  it('tells a losing player which of the two things happened', () => {
    expect(stateLine(session({ status: 'resigned', winnerId: bob.id }), alice.id, 'Robin', '', NOW)).toBe(
      'You resigned.',
    );
    expect(stateLine(session({ status: 'resigned', winnerId: alice.id }), alice.id, 'Robin', '', NOW)).toBe(
      'Robin resigned. You win.',
    );
    expect(stateLine(session({ status: 'timeout', winnerId: alice.id }), alice.id, 'Robin', '', NOW)).toBe(
      'Robin ran out of time. You win.',
    );
  });

  it('keeps an exchange message, and drops a notice that only repeats the outcome', () => {
    const open = session({ turn: 'b' });
    expect(stateLine(open, alice.id, 'Robin', 'Take-back declined. The move stands.', NOW)).toMatch(
      /^Take-back declined\. The move stands\./,
    );
    expect(stateLine(session({}), alice.id, 'Robin', 'Your move.', NOW)).toBe('Your move.');
  });
});