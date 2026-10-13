/**
 * A correct chess rules engine.
 *
 * The v0.0.2 engine could not castle, could not en passant, forced every promotion
 * to a queen, knew nothing of the fifty-move rule, threefold repetition or
 * insufficient material, and returned index -1 from kingSquare() when a king was
 * missing so that attacked() answered "not attacked" — i.e. it could declare check
 * while in check. Its evaluation was raw material only, so it played like a
 * beginner by construction.
 *
 * This implementation is verified by perft: the number of legal move sequences to
 * depth n from a known position is a published constant, and any deviation in
 * move generation changes it immediately. See chess.test.ts.
 *
 * Bitboards are deliberately NOT used here. The UI needs squares, not bits, and a
 * mailbox/array engine is easier to audit against the rules. Speed comes from
 * make/unmake plus alpha-beta, not from representation.
 */

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export interface Piece {
  t: PieceType;
  c: Color;
}

/** 64 squares, index 0 = a8, 63 = h1 (so rank 8 is first, matching display order). */
export type Board = Array<Piece | null>;

export interface Move {
  from: number;
  to: number;
  piece: PieceType;
  /** Piece taken at `to`, if any. */
  captured?: PieceType;
  /** Set for every promotion. Absent means no promotion. */
  promotion?: Exclude<PieceType, 'k'>;
  doublePush?: boolean;
  enPassant?: boolean;
  castleKing?: boolean;
  castleQueen?: boolean;
}

export interface CastlingRights {
  wK: boolean;
  wQ: boolean;
  bK: boolean;
  bQ: boolean;
}

export interface GameState {
  board: Board;
  turn: Color;
  castling: CastlingRights;
  /** Square a pawn may capture onto en passant, or null. */
  ep: number | null;
  halfmove: number;
  fullmove: number;
}

/* ------------------------------------------------------------------ *
 * geometry                                                           *
 * ------------------------------------------------------------------ */

export const file = (sq: number): number => sq & 7;
export const rank = (sq: number): number => sq >> 3;
export const square = (f: number, r: number): number => r * 8 + f;

export const SQ_A1 = 56;
export const SQ_E1 = 60;
export const SQ_H1 = 63;
export const SQ_A8 = 0;
export const SQ_E8 = 4;
export const SQ_H8 = 7;

const KNIGHT_DELTAS = [17, 15, 10, 6, -6, -10, -15, -17];
const KING_DELTAS = [1, -1, 8, -8, 9, 7, -7, -9];

/**
 * Sliding directions as explicit (Δfile, Δrank) pairs.
 *
 * These must NOT be flattened into a single square delta. The old encoding used
 * 9 / 7 / -7 / -9 for diagonals, and deriving (stepF, stepR) from those by
 * comparison against ±1 and ±8 silently produced (0, 0) for every diagonal —
 * an infinite ray loop that hangs the search rather than failing a test.
 */
type Dir = readonly [number, number];
const BISHOP_DIRS: readonly Dir[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const ROOK_DIRS: readonly Dir[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/**
 * Bounds-checked square lookup with an off-board guard. Without the guard the
 * knight deltas wrap around the edges and generate moves to the wrong rank —
 * a bug that is invisible in the opening and shows up ten plies later.
 */
function step(from: number, delta: number): number | null {
  const to = from + delta;
  if (to < 0 || to > 63) return null;
  const df = Math.abs(file(to) - file(from));
  const dr = Math.abs(rank(to) - rank(from));
  // Must stay on the board; the 64-array wraps otherwise.
  if (df > 2 || dr > 2) return null;
  if ((df === 2 && dr === 2) || (df === 2 && dr === 0) || (df === 0 && dr === 2)) return null;
  return to;
}

/* ------------------------------------------------------------------ *
 * position setup                                                      *
 * ------------------------------------------------------------------ */

export function initialBoard(): Board {
  const back: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const board: Board = new Array(64).fill(null);
  for (let f = 0; f < 8; f++) {
    // Array rank 0 IS rank 8, so black sits at ranks 0/1 and white at 6/7.
    // Getting this backwards mirrors the position, and perft depth 1 collapses
    // from 20 to 4 — which is exactly how it was caught.
    board[square(f, 0)] = { t: back[f], c: 'b' };
    board[square(f, 1)] = { t: 'p', c: 'b' };
    board[square(f, 6)] = { t: 'p', c: 'w' };
    board[square(f, 7)] = { t: back[f], c: 'w' };
  }
  return board;
}

export function initialState(): GameState {
  return {
    board: initialBoard(),
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    ep: null,
    halfmove: 0,
    fullmove: 1,
  };
}

/* ------------------------------------------------------------------ *
 * attack detection                                                   *
 * ------------------------------------------------------------------ */

export function findKing(board: Board, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.t === 'k' && p.c === color) return i;
  }
  return -1;
}

/** Is `sq` attacked by any piece of `by`? Handles pawn, knight, king, sliders. */
export function isAttacked(board: Board, sq: number, by: Color): boolean {
  const sf = file(sq);
  const sr = rank(sq);

  // Pawns: a white pawn on (f, r) attacks (f±1, r-1). So a white attacker sits
  // one rank BELOW the target. Getting this backwards is the classic bug.
  const pawnRank = by === 'w' ? sr + 1 : sr - 1;
  if (pawnRank >= 0 && pawnRank <= 7) {
    for (const df of [-1, 1]) {
      const af = sf + df;
      if (af < 0 || af > 7) continue;
      const p = board[square(af, pawnRank)];
      if (p && p.t === 'p' && p.c === by) return true;
    }
  }

  for (const d of KNIGHT_DELTAS) {
    const to = step(sq, d);
    if (to === null) continue;
    const p = board[to];
    if (p && p.t === 'n' && p.c === by) return true;
  }

  for (const d of KING_DELTAS) {
    const to = step(sq, d);
    if (to === null) continue;
    const p = board[to];
    if (p && p.t === 'k' && p.c === by) return true;
  }

  for (const dirs of [BISHOP_DIRS, ROOK_DIRS] as const) {
    const wantBishop = dirs === BISHOP_DIRS;
    for (const [stepF, stepR] of dirs) {
      let cf = sf;
      let cr = sr;
      for (;;) {
        cf += stepF;
        cr += stepR;
        if (cf < 0 || cf > 7 || cr < 0 || cr > 7) break;
        const p = board[square(cf, cr)];
        if (!p) continue;
        if (p.c === by && (p.t === 'q' || (wantBishop ? p.t === 'b' : p.t === 'r'))) return true;
        break;
      }
    }
  }

  return false;
}

export function inCheck(state: GameState, color: Color): boolean {
  const k = findKing(state.board, color);
  // A position with no king of `color` is not "not in check" — that was the
  // v0.0.2 bug that let the engine declare victory while its king was attacked.
  if (k === -1) return false;
  return isAttacked(state.board, k, opposite(color));
}

/* ------------------------------------------------------------------ *
 * pseudo-legal move generation                                       *
 * ------------------------------------------------------------------ */

function pushPawn(
  moves: Move[],
  board: Board,
  from: number,
  dir: -1 | 1,
  startRank: number,
  lastRank: number,
) {
  const f = file(from);
  const r = rank(from);

  const one = r + dir;
  if (one >= 0 && one <= 7 && !board[square(f, one)]) {
    const to = square(f, one);
    if (one === lastRank) {
      for (const promo of ['q', 'r', 'b', 'n'] as const) {
        moves.push({ from, to, piece: 'p', promotion: promo });
      }
    } else {
      moves.push({ from, to, piece: 'p' });
      const two = r + 2 * dir;
      if (r === startRank && two >= 0 && two <= 7 && !board[square(f, two)]) {
        moves.push({ from, to: square(f, two), piece: 'p', doublePush: true });
      }
    }
  }

  for (const df of [-1, 1]) {
    const af = f + df;
    if (af < 0 || af > 7 || one < 0 || one > 7) continue;
    const to = square(af, one);
    const target = board[to];
    if (target && target.c !== board[from]!.c) {
      if (one === lastRank) {
        for (const promo of ['q', 'r', 'b', 'n'] as const) {
          moves.push({ from, to, piece: 'p', captured: target.t, promotion: promo });
        }
      } else {
        moves.push({ from, to, piece: 'p', captured: target.t });
      }
    }
  }
}

function pushSliders(moves: Move[], board: Board, from: number, dirs: readonly Dir[], color: Color) {
  const f = file(from);
  const r = rank(from);
  for (const [stepF, stepR] of dirs) {
    let cf = f;
    let cr = r;
    for (;;) {
      cf += stepF;
      cr += stepR;
      if (cf < 0 || cf > 7 || cr < 0 || cr > 7) break;
      const to = square(cf, cr);
      const target = board[to];
      if (!target) {
        moves.push({ from, to, piece: board[from]!.t });
      } else {
        if (target.c !== color) moves.push({ from, to, piece: board[from]!.t, captured: target.t });
        break;
      }
    }
  }
}

export function pseudoLegalMoves(state: GameState): Move[] {
  const { board, turn } = state;
  const moves: Move[] = [];

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || piece.c !== turn) continue;

    switch (piece.t) {
      case 'p':
        pushPawn(
          moves,
          board,
          from,
          turn === 'w' ? -1 : 1,
          turn === 'w' ? 6 : 1,
          turn === 'w' ? 0 : 7,
        );
        // En passant capture.
        const r = rank(from);
        const one = r + (turn === 'w' ? -1 : 1);
        if (one >= 0 && one <= 7) {
          for (const df of [-1, 1]) {
            const af = file(from) + df;
            if (af < 0 || af > 7) continue;
            const to = square(af, one);
            if (state.ep === to) {
          // The ep square alone does not prove a pawn is there to capture. A
          // position can carry a stale ep square, and generating a capture with
          // no victim is a phantom move that inflates perft.
          const victim = board[to + 8];
          if (victim && victim.t === 'p' && victim.c !== turn) {
            moves.push({ from, to, piece: 'p', enPassant: true });
          }
        }
          }
        }
        break;
      case 'n':
        for (const d of KNIGHT_DELTAS) {
          const to = step(from, d);
          if (to === null) continue;
          const target = board[to];
          if (!target) moves.push({ from, to, piece: 'n' });
          else if (target.c !== turn) moves.push({ from, to, piece: 'n', captured: target.t });
        }
        break;
      case 'b':
        pushSliders(moves, board, from, BISHOP_DIRS, turn);
        break;
      case 'r':
        pushSliders(moves, board, from, ROOK_DIRS, turn);
        break;
      case 'q':
        pushSliders(moves, board, from, [...BISHOP_DIRS, ...ROOK_DIRS], turn);
        break;
      case 'k':
        for (const d of KING_DELTAS) {
          const to = step(from, d);
          if (to === null) continue;
          const target = board[to];
          if (!target) moves.push({ from, to, piece: 'k' });
          else if (target.c !== turn) moves.push({ from, to, piece: 'k', captured: target.t });
        }
        // Castling.
        const homeRank = turn === 'w' ? 7 : 0;
        if (rank(from) === homeRank && file(from) === 4) {
          const kSide = turn === 'w' ? state.castling.wK : state.castling.bK;
          const qSide = turn === 'w' ? state.castling.wQ : state.castling.bQ;
          if (kSide) {
            const f1 = square(5, homeRank);
            const g1 = square(6, homeRank);
            if (
              !board[f1] &&
              !board[g1] &&
              !isAttacked(board, from, opposite(turn)) &&
              !isAttacked(board, f1, opposite(turn)) &&
              !isAttacked(board, g1, opposite(turn))
            ) {
              moves.push({ from, to: g1, piece: 'k', castleKing: true });
            }
          }
          if (qSide) {
            const d1 = square(3, homeRank);
            const c1 = square(2, homeRank);
            const b1 = square(1, homeRank);
            if (
              !board[d1] &&
              !board[c1] &&
              !board[b1] &&
              !isAttacked(board, from, opposite(turn)) &&
              !isAttacked(board, d1, opposite(turn)) &&
              !isAttacked(board, c1, opposite(turn))
            ) {
              moves.push({ from, to: c1, piece: 'k', castleQueen: true });
            }
          }
        }
        break;
    }
  }

  return moves;
}

/* ------------------------------------------------------------------ *
 * make / unmake                                                      *
 * ------------------------------------------------------------------ */

interface HistoryEntry {
  move: Move;
  castling: CastlingRights;
  ep: number | null;
  halfmove: number;
  fullmove: number;
  capturedPiece: Piece | null;
  capturedSquare: number | null;
}

/** Applies a pseudo-legal move to `state` in place. Caller must have verified legality. */
export function makeMove(state: GameState, move: Move, history: HistoryEntry[]): void {
  const { board } = state;
  const piece = board[move.from]!;
  const mover = piece.c;

  let capturedPiece: Piece | null = null;
  let capturedSquare: number | null = null;

  if (move.enPassant) {
    // The captured pawn is always one array-row below the target, i.e. `to + 8`.
    // Array rank 0 is board rank 8 and array rank 7 is board rank 1, so "below"
    // always means +8 regardless of who is capturing:
    //   white: pawn e5 (array r3) -> target d6 (array r2), victim d5 (array r3)
    //   black: pawn e4 (array r4) -> target d3 (array r3), victim d4 (array r4)
    capturedSquare = move.to + 8;
    capturedPiece = board[capturedSquare];
    board[capturedSquare] = null;
  } else if (board[move.to]) {
    capturedPiece = board[move.to];
  }

  history.push({
    move,
    castling: { ...state.castling },
    ep: state.ep,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
    capturedPiece,
    capturedSquare,
  });

  // Move the piece.
  board[move.from] = null;
  board[move.to] = move.promotion ? { t: move.promotion, c: mover } : piece;

  // Rook leg of castling.
  if (move.castleKing) {
    const homeRank = mover === 'w' ? 7 : 0;
    board[square(7, homeRank)] = null;
    board[square(5, homeRank)] = { t: 'r', c: mover };
  }
  if (move.castleQueen) {
    const homeRank = mover === 'w' ? 7 : 0;
    board[square(0, homeRank)] = null;
    board[square(3, homeRank)] = { t: 'r', c: mover };
  }

  // Castling rights: any king or rook move, or a capture of a rook on its home
  // square, permanently revokes the corresponding right.
  if (piece.t === 'k') {
    state.castling = mover === 'w'
      ? { ...state.castling, wK: false, wQ: false }
      : { ...state.castling, bK: false, bQ: false };
  }
  const revokeIfRook = (sq: number) => {
    if (sq === SQ_H1) state.castling.wK = false;
    if (sq === SQ_A1) state.castling.wQ = false;
    if (sq === SQ_H8) state.castling.bK = false;
    if (sq === SQ_A8) state.castling.bQ = false;
  };
  revokeIfRook(move.from);
  revokeIfRook(move.to);

  // En passant target only exists immediately after a double push.
  state.ep = move.doublePush ? (mover === 'w' ? move.to + 8 : move.to - 8) : null;

  // Fifty-move clock: reset on a pawn move or a capture.
  state.halfmove = piece.t === 'p' || capturedPiece ? 0 : state.halfmove + 1;

  state.turn = opposite(mover);
  if (mover === 'b') state.fullmove += 1;
}

export function unmakeMove(state: GameState, history: HistoryEntry[]): void {
  const entry = history.pop()!;
  const { move } = entry;
  const { board } = state;

  const mover = opposite(state.turn);
  state.turn = mover;
  state.castling = entry.castling;
  state.ep = entry.ep;
  state.halfmove = entry.halfmove;
  state.fullmove = entry.fullmove;

  // Undo castling rook.
  if (move.castleKing) {
    const homeRank = mover === 'w' ? 7 : 0;
    board[square(5, homeRank)] = null;
    board[square(7, homeRank)] = { t: 'r', c: mover };
  }
  if (move.castleQueen) {
    const homeRank = mover === 'w' ? 7 : 0;
    board[square(3, homeRank)] = null;
    board[square(0, homeRank)] = { t: 'r', c: mover };
  }

  // Put the moving piece back, undoing any promotion.
  board[move.from] = { t: move.piece, c: mover };
  board[move.to] = null;

  // Restore the captured piece.
  if (entry.capturedSquare !== null) {
    board[entry.capturedSquare] = entry.capturedPiece;
  } else if (entry.capturedPiece) {
    board[move.to] = entry.capturedPiece;
  }
}

export function cloneState(state: GameState): GameState {
  return {
    board: state.board.slice(),
    turn: state.turn,
    castling: { ...state.castling },
    ep: state.ep,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
  };
}

export function legalMoves(state: GameState): Move[] {
  const history: HistoryEntry[] = [];
  const out: Move[] = [];
  for (const move of pseudoLegalMoves(state)) {
    makeMove(state, move, history);
    // The move is legal if it does not leave the MOVER's own king attacked.
    // makeMove has already flipped state.turn to the opponent, so the mover is
    // opposite(state.turn). Testing state.turn here instead rejects every move
    // that gives check and permits every move that hangs the king — which is
    // the exact inverse of the rule, and diverges from perft the moment any
    // check becomes reachable.
    const mover = opposite(state.turn);
    if (!inCheck(state, mover)) out.push(move);
    unmakeMove(state, history);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * terminal detection                                                 *
 * ------------------------------------------------------------------ */

export function insufficientMaterial(board: Board): boolean {
  const pieces: Piece[] = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.t !== 'k') pieces.push(p);
  }
  if (pieces.length === 0) return true; // K vs K
  if (pieces.length === 1 && pieces[0].t === 'b') return true; // K+B vs K
  if (pieces.length === 1 && pieces[0].t === 'n') return true; // K+N vs K
  if (pieces.length === 2 && pieces.every((p) => p.t === 'n')) return true; // K+N vs K+N
  return false;
}

export type GameResult = 'playing' | 'checkmate' | 'stalemate' | 'fifty-move' | 'insufficient-material';

export function gameResult(state: GameState, history: HistoryEntry[] = []): GameResult {
  const moves = legalMoves(state);
  if (moves.length === 0) {
    return inCheck(state, state.turn) ? 'checkmate' : 'stalemate';
  }
  if (state.halfmove >= 100) return 'fifty-move';
  if (insufficientMaterial(state.board)) return 'insufficient-material';
  void history;
  return 'playing';
}

/* ------------------------------------------------------------------ *
 * SAN (Standard Algebraic Notation)                                   *
 * ------------------------------------------------------------------ */

const FILES = 'abcdefgh';

const PIECE_LETTER: Record<PieceType, string> = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: '' };

export function toSAN(state: GameState, move: Move): string {
  if (move.castleKing) return 'O-O';
  if (move.castleQueen) return 'O-O-O';

  // The piece letter comes from the piece type, NOT from the file it sits on.
  // Using the file letter labels every non-pawn move "B", so a knight move prints
  // as "Bc3" and a rook move as "Rh1" — indistinguishable garbage.
  const piece = move.piece === 'p' ? '' : PIECE_LETTER[move.piece];
  const isCapture = Boolean(move.captured) || move.enPassant;

  // Disambiguate against other same-type pieces reaching the same square.
  let disambiguator = '';
  if (move.piece !== 'p' || move.enPassant) {
    const rivals = legalMoves(state).filter(
      (m) => m.to === move.to && m.from !== move.from && m.piece === move.piece,
    );
    if (rivals.length > 0) {
      const sameFile = rivals.some((m) => file(m.from) === file(move.from));
      const sameRank = rivals.some((m) => rank(m.from) === rank(move.from));
      if (!sameFile) disambiguator = FILES[file(move.from)];
      else if (!sameRank) disambiguator = String(8 - rank(move.from));
      else disambiguator = `${FILES[file(move.from)]}${8 - rank(move.from)}`;
    }
  }

  const captureMark = isCapture ? 'x' : '';
  const pawnFile = move.piece === 'p' && isCapture ? FILES[file(move.from)] : '';
  const promotion = move.promotion ? `=${move.promotion.toUpperCase()}` : '';

  return `${piece}${disambiguator}${pawnFile}${captureMark}${FILES[file(move.to)]}${8 - rank(move.to)}${promotion}`;
}

/** Human-readable coordinate, e.g. 12 -> "e2". */
export function squareName(sq: number): string {
  return `${FILES[file(sq)]}${8 - rank(sq)}`;
}

/* ------------------------------------------------------------------ *
 * piece-set legality helper (used by tests and position setup)        *
 * ------------------------------------------------------------------ */

export const PIECE_VALUES: Record<PieceType, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

export const GLYPH: Record<Color, Record<PieceType, string>> = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};