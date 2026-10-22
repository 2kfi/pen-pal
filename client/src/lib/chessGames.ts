/**
 * Two-player chess over the wire (plan step 26).
 *
 * This is the client half of the contract described in
 * `server/lib/migrations/050-game-sessions.js`. It has three jobs:
 *
 *   1. Serialise a `GameState` into the plaintext that goes *inside* a letter
 *      envelope, and back out again.
 *   2. Seal and open that plaintext with the same `sealLetter`/`openLetter` the
 *      rest of the app uses, so a chess position is encrypted by exactly the
 *      code path a letter is, with the same AAD binding and the same
 *      wrapped-key-per-participant layout.
 *   3. Talk to `/api/games`.
 *
 * ## The one thing this file cannot do
 *
 * It cannot verify its opponent's moves, and it cannot verify that the position
 * it was handed is the position those moves produce. That is what end-to-end
 * encryption costs here, and the server says so out loud rather than pretending
 * to check it. What the client *can* check, and does:
 *
 *   - the sealed position must replay into the same move list that was sealed
 *     with it. A mismatch means the two ends disagree about the game, which is
 *     the one case where refusing to draw the board is the honest thing to do.
 *   - the moves it offers are generated locally by the perft-verified rules
 *     engine, so it never sends a move it did not verify as legal in the
 *     position it sealed.
 */

import {
  cloneState,
  gameResult,
  initialState,
  legalMoves,
  makeMove,
  toSAN,
  type Board,
  type CastlingRights,
  type Color,
  type GameState,
  type Move,
} from './chessEngine';
import { openLetter, sealLetter } from './crypto';
import { api } from './api';

/**
 * The rules engine's undo-stack type is not exported (same workaround as
 * ChessBoard.tsx): `makeMove`'s third parameter is the only handle on it.
 */
type UndoStack = Parameters<typeof makeMove>[2];

/* ------------------------------------------------------------------ *
 * wire types                                                         *
 * ------------------------------------------------------------------ */

export type GameStatus = 'open' | 'checkmate' | 'stalemate' | 'draw' | 'resigned' | 'timeout';

export const TERMINAL_STATUSES: readonly GameStatus[] = [
  'checkmate',
  'stalemate',
  'draw',
  'resigned',
  'timeout',
];

export function isOver(status: GameStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A session as the server sends it. Every position is an opaque envelope. */
export interface GameSession {
  id: number;
  pairKey: string;
  whiteId: number;
  blackId: number;
  /** Which side the authenticated user is playing, or null if not this pair's. */
  youAre: Color | null;
  turn: Color;
  status: GameStatus;
  winnerId: number | null;
  youWon: boolean;
  moveCount: number;
  lastMoveBy: number | null;
  lastMoveAt: string | null;
  /** Optimistic-concurrency token. Send it with every write. */
  version: number;
  encryptedState: string;
  undo: { offeredBy: number; fromYou: boolean; encryptedState: string } | null;
  draw: { offeredBy: number; fromYou: boolean } | null;
  /** When the side to move must answer by, or null if timeouts are off. */
  turnDeadline: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface GameSummary {
  id: number;
  status: GameStatus;
  turn: Color;
  youAre: Color | null;
  moveCount: number;
  winnerId: number | null;
  version: number;
  updatedAt: string;
  closedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * the sealed payload                                                 *
 * ------------------------------------------------------------------ */

/** One ply, as sealed. SAN is for the move list; `uci` is what a replay matches on. */
export interface SealedMove {
  ply: number;
  color: Color;
  san: string;
  /**
   * The move key produced by `uciOf`: decimal from and to indices, delimited.
   * Not algebraic UCI. See `uciOf`.
   */
  uci: string;
  at: string;
}

/**
 * The plaintext of a position envelope.
 *
 * The board is stored as the engine's own array rather than as a FEN string
 * because the engine has no FEN parser, and writing one here would create a
 * second, untested path into the position that the perft-verified tests do not
 * cover. Rehydrating is a field copy of a structure that is already plain JSON.
 *
 * `moves` is kept so a reconnecting client can draw the move list without
 * replaying anything, and so the two ends can be compared.
 */
export interface SealedGame {
  v: 1;
  board: Board;
  turn: Color;
  castling: CastlingRights;
  ep: number | null;
  halfmove: number;
  fullmove: number;
  moves: SealedMove[];
  /** What the sender's rules engine concluded. The server cannot check it. */
  result: GameStatus;
}

/**
 * A move key for the sealed record: the sender's own square indices.
 *
 * NOT algebraic UCI. Despite what the old name and comment claimed, this is
 * `${from}${to}${promotion}` with decimal indices, and concatenating two
 * variable-width numbers is ambiguous: from=1,to=10 and from=11,to=0 both
 * produce "110". Nothing shipped depends on the format, both peers compute it
 * identically, and it only ever has to survive a round trip through the server,
 * so the fix is a delimiter rather than a migration.
 */
export function uciOf(move: Move): string {
  return `${move.from}:${move.to}:${move.promotion ?? ''}`;
}

/** A fresh position, straight from the rules engine. */
export function newLocalGame(): GameState {
  return initialState();
}

export function applyMove(state: GameState, move: Move, moves: SealedMove[]): { state: GameState; record: SealedMove } {
  const replay = cloneState(state);
  const history: UndoStack = [];
  const san = toSAN(replay, move);
  makeMove(replay, move, history);
  return {
    state: replay,
    record: {
      ply: moves.length + 1,
      color: state.turn,
      san,
      uci: uciOf(move),
      at: new Date().toISOString(),
    },
  };
}

/** Maps the rules engine's verdict onto the status vocabulary the server knows. */
export function statusFromBoard(state: GameState): GameStatus {
  const verdict = gameResult(state);
  if (verdict === 'checkmate') return 'checkmate';
  if (verdict === 'stalemate' || verdict === 'fifty-move' || verdict === 'insufficient-material') {
    return 'draw';
  }
  return 'open';
}

/**
 * Rebuilds the position before the last ply of a sealed list.
 *
 * A take-back used to live only in page memory, so a refresh destroyed it and
 * the offer could not be made. It does not have to be that way: the sealed move
 * list IS the history, and replaying one ply short of the end is the position
 * the server's rewind would hand back. Throws if a move is not legal, which
 * verifySealedGame guards first — this is for a list that already passed.
 */
export function positionBeforeLastPly(moves: SealedMove[]): { position: GameState; moves: SealedMove[] } {
  if (moves.length === 0) throw new Error('There are no moves to roll back.');
  const replay = initialState();
  const history: UndoStack = [];
  for (const sealed of moves.slice(0, -1)) {
    const found = legalMoves(replay).find((m) => uciOf(m) === sealed.uci);
    if (!found) throw new Error(`Move ${sealed.ply} (${sealed.san}) is not legal in the position before it.`);
    makeMove(replay, found, history);
  }
  return { position: replay, moves: moves.slice(0, -1) };
}

export function sealPayload(state: GameState, moves: SealedMove[]): SealedGame {
  return {
    v: 1,
    board: state.board,
    turn: state.turn,
    castling: state.castling,
    ep: state.ep,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    moves,
    result: statusFromBoard(state),
  };
}

export function stateFromPayload(payload: SealedGame): GameState {
  return {
    board: payload.board,
    turn: payload.turn,
    castling: payload.castling,
    ep: payload.ep,
    halfmove: payload.halfmove,
    fullmove: payload.fullmove,
  };
}

export function isSealedGame(value: unknown): value is SealedGame {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<SealedGame>;
  return p.v === 1 && Array.isArray(p.board) && p.board.length === 64 && Array.isArray(p.moves);
}

/**
 * Replays a sealed move list and checks it lands on the sealed board.
 *
 * This is the client's half of "we do not have to trust each other, we just have
 * to notice a disagreement". Returns null when the list and the board agree, or
 * a human sentence when they do not — a mismatch means the two ends are not
 * playing the same game, and drawing the board anyway would be a lie.
 */
export function verifySealedGame(payload: SealedGame): string | null {
  const replay = initialState();
  const history: UndoStack = [];
  for (const sealed of payload.moves) {
    const legal = legalMoves(replay);
    const found = legal.find((m) => uciOf(m) === sealed.uci);
    if (!found) {
      return `Move ${sealed.ply} (${sealed.san}) is not legal in the position before it.`;
    }
    makeMove(replay, found, history);
  }
  const same =
    replay.turn === payload.turn &&
    replay.halfmove === payload.halfmove &&
    replay.fullmove === payload.fullmove &&
    replay.board.every((piece, i) => {
      const other = payload.board[i];
      if (!piece || !other) return piece === other;
      return piece.t === other.t && piece.c === other.c;
    });
  return same ? null : 'The move list does not rebuild the position that came with it.';
}

/* ------------------------------------------------------------------ *
 * sealing                                                            *
 * ------------------------------------------------------------------ */

export interface SealContext {
  senderId: number;
  partnerId: number;
  senderPublicKey: JsonWebKey;
  partnerPublicKey: JsonWebKey;
}

/**
 * Seals a position for both players.
 *
 * `sealLetter` wraps the content key to sender *and* recipient. For a letter
 * that is a convenience; for a position it is a requirement, because after a
 * move both sides re-read the same envelope — the mover on the move list, the
 * other on the next refresh — and an envelope only one of them could open would
 * break the reconnect guarantee.
 */
export async function sealGame(game: SealedGame, ctx: SealContext): Promise<string> {
  const envelope = await sealLetter(JSON.stringify(game), {
    senderId: ctx.senderId,
    recipientId: ctx.partnerId,
    senderPublicKey: ctx.senderPublicKey,
    recipientPublicKey: ctx.partnerPublicKey,
    sentAt: new Date().toISOString(),
  });
  return JSON.stringify(envelope);
}

export async function openGame(
  envelope: string,
  privateKey: CryptoKey,
  viewerId: number,
): Promise<SealedGame> {
  const parsed: unknown = JSON.parse(envelope);
  const plain = await openLetter(parsed as Parameters<typeof openLetter>[0], privateKey, viewerId);
  const value: unknown = JSON.parse(plain);
  if (!isSealedGame(value)) throw new Error('The sealed position is not in a format this client understands.');
  return value;
}

/* ------------------------------------------------------------------ *
 * the API                                                            *
 * ------------------------------------------------------------------ */

export interface CreateGameInput {
  color: Color;
  /** The sealed starting position — normally a fresh board. */
  encryptedState: string;
}

export interface MoveInput {
  color: Color;
  version: number;
  encryptedState: string;
  /** Omit to keep playing; pass `checkmate`/`stalemate`/`draw` to finish. */
  status?: GameStatus;
}

export const gamesApi = {
  list: () => api<{ games: GameSummary[]; activeId: number | null }>('/api/games'),
  active: () => api<{ game: GameSession | null }>('/api/games/active'),
  get: (id: number) => api<{ game: GameSession }>(`/api/games/${id}`),
  create: (input: CreateGameInput) =>
    api<{ created: boolean; game: GameSession }>('/api/games', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  move: (id: number, input: MoveInput) =>
    api<{ accepted: boolean; ply: number; game: GameSession }>(`/api/games/${id}/move`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  resign: (id: number) => api<{ resigned: boolean; game: GameSession }>(`/api/games/${id}/resign`, { method: 'POST' }),
  offerDraw: (id: number) => api<{ offered: boolean; game: GameSession }>(`/api/games/${id}/draw`, { method: 'POST' }),
  acceptDraw: (id: number) =>
    api<{ drawn: boolean; game: GameSession }>(`/api/games/${id}/draw/accept`, { method: 'POST' }),
  declineDraw: (id: number) =>
    api<{ declined: boolean; game: GameSession }>(`/api/games/${id}/draw/decline`, { method: 'POST' }),
  offerUndo: (id: number, input: { version: number; encryptedState: string }) =>
    api<{ offered: boolean; game: GameSession }>(`/api/games/${id}/undo`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  acceptUndo: (id: number, version: number) =>
    api<{ accepted: boolean; game: GameSession }>(`/api/games/${id}/undo/accept`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),
  declineUndo: (id: number) =>
    api<{ declined: boolean; game: GameSession }>(`/api/games/${id}/undo/decline`, { method: 'POST' }),
};

/* ------------------------------------------------------------------ *
 * reading a result out loud                                          *
 * ------------------------------------------------------------------ */

/**
 * One sentence for the banner, and nothing clever.
 *
 * "You win by resignation" and "you win" are very different messages to receive,
 * and a UI that cannot say which one happened is a UI that gets griefed about.
 */
export function describeOutcome(session: GameSession, viewerId: number, partnerName = 'your partner'): string {
  const iWon = session.winnerId !== null && session.winnerId === viewerId;
  const iLost = session.winnerId !== null && session.winnerId !== viewerId;

  switch (session.status) {
    case 'checkmate':
      return iWon ? 'Checkmate. You win.' : iLost ? `Checkmate. ${partnerName} wins.` : 'Checkmate. Drawn.';
    case 'stalemate':
      return 'Stalemate. A draw.';
    case 'draw':
      return 'Agreed draw.';
    case 'resigned':
      return iLost ? 'You resigned.' : `${partnerName} resigned. You win.`;
    case 'timeout':
      return iLost
        ? 'The clock ran out on your move.'
        : `${partnerName} ran out of time. You win.`;
    case 'open':
    default:
      return session.turn === session.youAre ? 'Your move.' : `${partnerName} to move.`;
  }
}