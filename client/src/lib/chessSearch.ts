/**
 * Chess search (plan step 25).
 *
 * v0.0.2 shipped "a depth-2 alpha-beta over a material-only evaluation, run
 * synchronously on the main thread". Two things were wrong with that and both
 * were structural rather than tunable:
 *
 *   1. Material-only evaluation plays like a beginner BY CONSTRUCTION. It has
 *      no opinion about a knight on c3 versus a knight on a1, so it will happily
 *      shuffle pieces back and forth at depth 4 and call it thought. The eval in
 *      this file is tapered (midgame/endgame) piece-square tables plus pawn
 *      structure, bishop pair, rook files and a king pawn shield.
 *   2. Running it on the main thread froze the page for the whole search. The
 *      user could not stop it and could not even scroll. Search here is written
 *      to be *cooperatively interruptible* — it yields to the event loop every
 *      slice and honours an abort flag — which is what makes a Worker in the
 *      next file a cancellable Worker rather than a decorative one.
 *
 * Structure of this file:
 *
 *   1. Evaluation: tapered PSTs + terms a material count cannot express.
 *   2. Zobrist keys, maintained INCREMENTALLY across make/unmake. Recomputing a
 *      64-square key at every node would cost more than the move generation it
 *      is meant to accelerate.
 *   3. A transposition table with depth-preferred replacement.
 *   4. Iterative deepening with aspiration windows, MVV-LVA + killers + history
 *      move ordering, null-move pruning, late move reductions, check extension.
 *   5. Quiescence search, so the engine does not walk into a capture it can see.
 *   6. Node AND time budgets. Both, because a budget that only counts nodes
 *      either hangs on a fast machine or gives up instantly on a slow one.
 *   7. The engine client: spawns `../chess.worker.ts`, falls back to an
 *      in-process search (with a visibly smaller budget) when the Worker
 *      constructor is missing or refused by CSP.
 *
 * Imports carry an explicit `.ts` extension. That is what bundler resolution
 * allows, and it is also what lets this exact file be loaded by Node's native
 * type stripping — which is how tests/chess.worker.test.js drives the real
 * worker module rather than a re-implementation of it.
 */

import {
  cloneState,
  file,
  inCheck,
  legalMoves,
  makeMove,
  pseudoLegalMoves,
  rank,
  square,
  toSAN,
  unmakeMove,
  type Board,
  type CastlingRights,
  type Color,
  type GameState,
  type Move,
  type Piece,
  type PieceType,
} from './chessEngine.ts';

/* ------------------------------------------------------------------ *
 * constants                                                           *
 * ------------------------------------------------------------------ */

/** The rules engine's undo-stack type is not exported; derive it. */
type UndoStack = Parameters<typeof makeMove>[2];

const opp = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/** Score for being mated. Far enough from any real eval that it can be seen through. */
export const MATE_SCORE = 30000;
/** A score this high is a forced mate, and `score - MATE_SCORE` is the ply it lands on. */
export const MATE_BOUND = MATE_SCORE - 1000;
const INFINITY = 1e9;
/** Hard recursion ceiling. Also bounds the undo stack and the killer table. */
const MAX_PLY = 64;

/** Values in centipawns, for capture ordering and delta pruning. */
const VALUE: Record<PieceType, number> = { p: 100, n: 320, b: 335, r: 500, q: 975, k: 20000 };
/** Same, but the king is not a capturable prize — it is only ever a tie-break. */
const ATTACK_VALUE: Record<PieceType, number> = { p: 100, n: 320, b: 335, r: 500, q: 975, k: 0 };

/* ------------------------------------------------------------------ *
 * difficulty                                                          *
 * ------------------------------------------------------------------ */

/**
 * Four levels, each a (depth, nodes, milliseconds) budget plus a centipawn
 * window from which the move is drawn.
 *
 * `randomness` is what makes the low levels beatable. A pure budget makes a weak
 * level weak *and* predictable: it will play the same second-best move every
 * time and be trivial to punish. Drawing from within `randomness` centipawns of
 * the best move keeps the engine legal and sane while stopping it being a
 * lookup table.
 */
export type Difficulty = 'beginner' | 'casual' | 'club' | 'tough';
/** The fifth setting: no randomness, and the largest budget the page will spend. */
export type EngineLevel = Difficulty | 'strong';
export type SearchLevel = EngineLevel;

export interface SearchBudget {
  /** Deepest iteration to attempt. Iterative deepening stops early on time anyway. */
  maxDepth: number;
  /** Total nodes across all iterations. */
  maxNodes: number;
  /** Wall-clock milliseconds across all iterations. */
  timeMs: number;
  /** Draw from within this many centipawns of the best move. 0 = always best. */
  randomness: number;
}

export const DIFFICULTY: Record<Difficulty, SearchBudget> = {
  beginner: { maxDepth: 1, maxNodes: 120, timeMs: 250, randomness: 140 },
  casual: { maxDepth: 2, maxNodes: 1500, timeMs: 450, randomness: 60 },
  club: { maxDepth: 4, maxNodes: 40_000, timeMs: 1600, randomness: 0 },
  tough: { maxDepth: 8, maxNodes: 400_000, timeMs: 4500, randomness: 0 },
};

/**
 * "Strong" is deliberately not a fifth rung on the same ladder: it spends up to
 * 15 seconds, which is fine for a human who asked for a real opponent and is
 * unacceptable as an automatic reply to every move.
 */
export const STRONG: SearchBudget = { maxDepth: 24, maxNodes: 6_000_000, timeMs: 15_000, randomness: 0 };

export const LEVEL_LABELS: Record<EngineLevel, string> = {
  beginner: 'Beginner',
  casual: 'Casual',
  club: 'Club',
  tough: 'Tough',
  strong: 'Strong',
};

export function budgetFor(level: EngineLevel, override?: Partial<SearchBudget>): SearchBudget {
  const base = level === 'strong' ? STRONG : DIFFICULTY[level];
  return { ...base, ...(override ?? {}) };
}

/** The smaller budget used when there is no Worker to run the real one in. */
export const FALLBACK_BUDGET: SearchBudget = {
  maxDepth: 2,
  maxNodes: 2500,
  timeMs: 400,
  randomness: 0,
};

/* ------------------------------------------------------------------ *
 * evaluation                                                          *
 * ------------------------------------------------------------------ */

/**
 * Piece-square tables, written in board-array order: row 0 is rank 8
 * (a8..h8) and row 7 is rank 1, which is exactly how `GameState.board` is
 * indexed. They are WHITE's tables. Black reads the same table at `sq ^ 56`,
 * which flips the rank and leaves the file alone — the correct vertical mirror.
 */
type Table = readonly number[];

const PAWN_MG: Table = [
    0,   0,   0,   0,   0,   0,   0,   0,
   98, 134,  61,  95,  68, 126,  34, -11,
   -6,   7,  26,  31,  65,  56,  25, -20,
  -14,  13,   6,  21,  23,  12,  17, -23,
  -27,  -2,  -5,  12,  17,   6,  10, -25,
  -26,  -4,  -4, -10,   3,   3,  33, -12,
  -35,  -1, -20, -23, -15,  24,  38, -22,
    0,   0,   0,   0,   0,   0,   0,   0,
];

const PAWN_EG: Table = [
    0,   0,   0,   0,   0,   0,   0,   0,
  178, 173, 158, 134, 147, 132, 165, 187,
   94, 100,  85,  67,  56,  53,  82,  84,
   32,  24,  13,   5,  -2,   4,  17,  17,
   13,   9,  -3,  -7,  -7,  -8,   3,  -1,
    4,   7,  -6,   1,   0,  -5,  -1,  -8,
   13,   8,   8,  10,  13,   0,   2,  -7,
    0,   0,   0,   0,   0,   0,   0,   0,
];

const KNIGHT_MG: Table = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];

const KNIGHT_EG: Table = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];

const BISHOP_MG: Table = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10,   5,   0,   0,   0,   0,   5, -10,
  -10,  10,  10,  10,  10,  10,  10, -10,
  -10,   0,  10,  10,  10,  10,   0, -10,
  -10,   5,   5,  10,  10,   5,   5, -10,
  -10,   0,   5,  10,  10,   5,   0, -10,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];

const BISHOP_EG: Table = [
  -14, -10, -10,  -8,  -8, -10, -10, -14,
  -10,   4,   0,   2,   2,   0,   4, -10,
  -10,   6,   8,  10,  10,   8,   6, -10,
   -8,   2,  10,  12,  12,  10,   2,  -8,
   -8,   4,  10,  12,  12,  10,   4,  -8,
  -10,   6,   8,  10,  10,   8,   6, -10,
  -10,   4,   0,   2,   2,   0,   4, -10,
  -14, -10, -10,  -8,  -8, -10, -10, -14,
];

const ROOK_MG: Table = [
    0,   0,   0,   0,   0,   0,   0,   0,
    5,  10,  10,  10,  10,  10,  10,   5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
    0,   0,   0,   0,   0,   0,   0,   0,
];

const ROOK_EG: Table = [
    0,   0,   0,   0,   0,   0,   0,   0,
    8,  12,  12,  12,  12,  12,  12,   8,
   -6,   2,   2,   2,   2,   2,   2,  -6,
   -6,   2,   2,   2,   2,   2,   2,  -6,
   -6,   2,   2,   2,   2,   2,   2,  -6,
   -6,   2,   2,   2,   2,   2,   2,  -6,
   -6,   2,   2,   2,   2,   2,   2,  -6,
    0,   0,   0,   0,   0,   0,   0,   0,
];

const QUEEN_MG: Table = [
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -10,   5,   5,   5,   5,   5,   0, -10,
    0,   0,   5,   5,   5,   5,   0,  -5,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
];

const QUEEN_EG: Table = [
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -10,   5,   5,   5,   5,   5,   0, -10,
    0,   0,   5,   5,   5,   5,   0,  -5,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
];

const KING_MG: Table = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   20,  20,   0,   0,   0,   0,  20,  20,
   20,  30,  10,   0,   0,  10,  30,  20,
];

const KING_EG: Table = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

const MG_TABLES: Record<PieceType, Table> = {
  p: PAWN_MG, n: KNIGHT_MG, b: BISHOP_MG, r: ROOK_MG, q: QUEEN_MG, k: KING_MG,
};
const EG_TABLES: Record<PieceType, Table> = {
  p: PAWN_EG, n: KNIGHT_EG, b: BISHOP_EG, r: ROOK_EG, q: QUEEN_EG, k: KING_EG,
};

/** Phase weights. A full board of material is 24. */
const PHASE_WEIGHT: Record<PieceType, number> = { p: 0, n: 1, b: 1, r: 2, q: 4, k: 0 };
const PHASE_MAX = 24;

/**
 * White reads at `sq`, black reads at `sq ^ 56`.
 *
 * `sq ^ 56` flips the rank (rank*8 + file, rank 0 is rank 8) and leaves the
 * file alone, which is exactly the vertical mirror black needs.
 */
function pst(mg: boolean, t: PieceType, sq: number, color: Color): number {
  const table = mg ? MG_TABLES[t] : EG_TABLES[t];
  return table[color === 'w' ? sq : sq ^ 56];
}

const PASSED_BONUS = [0, 6, 12, 26, 56, 100, 156, 0];

/**
 * Full static evaluation in centipawns, from WHITE's point of view.
 *
 * Exported because a raw eval score is genuinely useful on its own — the tests
 * use it to prove the piece-square tables are oriented correctly (a knight on c3
 * must beat a knight on a1) without going through a search, which could hide a
 * sign error behind an alpha-beta cut-off.
 */
export function evaluate(state: GameState): number {
  const board = state.board;
  let mg = 0;
  let eg = 0;
  let phase = 0;

  // Per-side scratch, gathered in one pass so the structural terms are not a
  // second walk over the board.
  const pawnFiles: Record<Color, Int8Array> = { w: new Int8Array(8), b: new Int8Array(8) };
  const pawnSquares: Record<Color, number[]> = { w: [], b: [] };
  const bishops: Record<Color, number> = { w: 0, b: 0 };
  const rookSquares: Record<Color, number[]> = { w: [], b: [] };
  const kingSquare: Record<Color, number> = { w: -1, b: -1 };
  let missingKing: Color | null = null;

  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p) continue;
    const sign = p.c === 'w' ? 1 : -1;
    mg += sign * (VALUE[p.t] + pst(true, p.t, sq, p.c));
    eg += sign * (VALUE[p.t] + pst(false, p.t, sq, p.c));
    phase += PHASE_WEIGHT[p.t];

    if (p.t === 'p') {
      pawnFiles[p.c][file(sq)] += 1;
      pawnSquares[p.c].push(sq);
    } else if (p.t === 'b') bishops[p.c] += 1;
    else if (p.t === 'r') rookSquares[p.c].push(sq);
    else if (p.t === 'k') kingSquare[p.c] = sq;
  }

  if (kingSquare.w === -1) missingKing = 'b';
  if (kingSquare.b === -1) missingKing = missingKing ?? 'w';

  /**
   * Pawn structure. These are the terms a material count cannot express, and
   * they are most of why the engine stops trading pawns for nothing.
   */
  for (const color of ['w', 'b'] as Color[]) {
    const sign = color === 'w' ? 1 : -1;
    const own = pawnFiles[color];
    const enemy = pawnFiles[opp(color)];

    if (bishops[color] >= 2) {
      mg += sign * 34;
      eg += sign * 52;
    }

    for (let f = 0; f < 8; f++) {
      const n = own[f];
      if (n === 0) continue;
      // Doubled: every pawn past the first on a file.
      if (n > 1) mg -= sign * (n - 1) * 16;
      // Isolated: no friendly pawn on an adjacent file.
      const left = f > 0 ? own[f - 1] : 0;
      const right = f < 7 ? own[f + 1] : 0;
      if (left === 0 && right === 0) {
        mg -= sign * 18;
        eg -= sign * 22;
      }
    }

    for (const sq of pawnSquares[color]) {
      const f = file(sq);
      // Passed means no enemy pawn on this or an adjacent file at or ahead of us.
      let blocked = false;
      for (let df = -1; df <= 1 && !blocked; df++) {
        const af = f + df;
        if (af < 0 || af > 7) continue;
        for (const esq of pawnSquares[opp(color)]) {
          if (file(esq) !== af) continue;
          // White advances toward rank 8 (array rank decreasing).
          if (color === 'w' ? rank(esq) >= rank(sq) : rank(esq) <= rank(sq)) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;
      const advanced = color === 'w' ? 7 - rank(sq) : rank(sq);
      mg += sign * PASSED_BONUS[advanced] * 0.6;
      eg += sign * PASSED_BONUS[advanced];
    }

    // Rooks like files with nothing of their own on them and something of the
    // enemy's on them.
    for (const sq of rookSquares[color]) {
      const f = file(sq);
      if (own[f] === 0) mg += sign * (enemy[f] === 0 ? 26 : 12);
    }

    // King pawn shield: pawns still in front of the king.
    const ksq = kingSquare[color];
    if (ksq >= 0) {
      const kr = rank(ksq);
      let shield = 0;
      for (let df = -1; df <= 1; df++) {
        const af = file(ksq) + df;
        if (af < 0 || af > 7) continue;
        for (const psq of pawnSquares[color]) {
          if (file(psq) !== af) continue;
          const ahead = color === 'w' ? rank(psq) < kr : rank(psq) > kr;
          if (!ahead) continue;
          const distance = Math.abs(rank(psq) - kr);
          if (distance <= 2) shield += 2;
          else if (distance <= 3) shield += 1;
        }
      }
      mg += sign * shield * 11;
      // In the endgame the king wants to come out, not hide.
      eg -= sign * shield * 6;
    }
  }

  if (missingKing) {
    // A king that is not on the board is a lost position, not an even one.
    return missingKing === 'w' ? -MATE_SCORE : MATE_SCORE;
  }

  const clamped = Math.min(phase, PHASE_MAX);
  const tapered = (mg * clamped + eg * (PHASE_MAX - clamped)) / PHASE_MAX;
  // Tempo: being the side to move is worth something, and it stops the engine
  // from claiming a theoretical draw on the move that gives it the chance to win.
  return Math.round(tapered) + (state.turn === 'w' ? 12 : -12);
}

/* ------------------------------------------------------------------ *
 * zobrist                                                             *
 * ------------------------------------------------------------------ */

/**
 * Two 32-bit halves rather than a BigInt. A BigInt key would be correct and
 * roughly 5x slower per node, and the collision risk of 64 bits is already far
 * below anything observable in a single game.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 0;
  };
}

const rng = makeRng(0x1a2b3c4d);

const COLOR_INDEX: Record<Color, number> = { w: 0, b: 1 };
const TYPE_INDEX: Record<PieceType, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

/** ZOBRIST[colorIndex][pieceTypeIndex][square] -> [hi, lo]. */
const ZOBRIST: number[][][][] = [];
for (let c = 0; c < 2; c++) {
  ZOBRIST[c] = [];
  for (let t = 0; t < 6; t++) {
    const row: number[][] = [];
    for (let sq = 0; sq < 64; sq++) row.push([rng(), rng()]);
    ZOBRIST[c][t] = row;
  }
}
const Z_SIDE: [number, number] = [rng(), rng()];
const Z_CASTLE: [number, number][] = [
  [rng(), rng()],
  [rng(), rng()],
  [rng(), rng()],
  [rng(), rng()],
];
/** [file] — hashed only when a capture is actually available on that file. */
const Z_EP: [number, number][] = [];
for (let f = 0; f < 8; f++) Z_EP.push([rng(), rng()]);

function keyOf(hi: number, lo: number): string {
  return `${hi.toString(36)}:${lo.toString(36)}`;
}

/* ------------------------------------------------------------------ *
 * position: engine state + incrementally maintained hash              *
 * ------------------------------------------------------------------ */

class Position {
  readonly state: GameState;
  hi: number;
  lo: number;
  private readonly stack: UndoStack = [];
  private readonly hashStack: number[] = [];
  /** Extra hashes pushed by null moves, which do not touch the undo stack. */
  private readonly nullHashes: number[] = [];

  constructor(state: GameState) {
    this.state = state;
    this.hi = 0;
    this.lo = 0;
    this.rehash();
  }

  rehash(): void {
    let hi = 0;
    let lo = 0;
    const board = this.state.board;
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (!p) continue;
      const z = ZOBRIST[COLOR_INDEX[p.c]][TYPE_INDEX[p.t]][sq];
      hi ^= z[0];
      lo ^= z[1];
    }
    const c = this.state.castling;
    if (c.wK) { hi ^= Z_CASTLE[0][0]; lo ^= Z_CASTLE[0][1]; }
    if (c.wQ) { hi ^= Z_CASTLE[1][0]; lo ^= Z_CASTLE[1][1]; }
    if (c.bK) { hi ^= Z_CASTLE[2][0]; lo ^= Z_CASTLE[2][1]; }
    if (c.bQ) { hi ^= Z_CASTLE[3][0]; lo ^= Z_CASTLE[3][1]; }
    if (this.state.turn === 'b') { hi ^= Z_SIDE[0]; lo ^= Z_SIDE[1]; }
    if (this.state.ep !== null && this.epIsReal()) {
      const z = Z_EP[file(this.state.ep)];
      hi ^= z[0];
      lo ^= z[1];
    }
    this.hi = hi >>> 0;
    this.lo = lo >>> 0;
  }

  /**
   * An en-passant square only goes into the hash when a pawn could actually take
   * on it. Hashing an unusable square means the same position reached with and
   * without a stale `ep` field gets two keys, and the transposition table stops
   * merging them.
   */
  private epIsReal(): boolean {
    const ep = this.state.ep;
    if (ep === null) return false;
    const board = this.state.board;
    const r = rank(ep);
    if (r < 1 || r > 6) return false;
    const side = this.state.turn;
    // The capturing pawn must sit on rank r+1 (array) for white, r-1 for black.
    const pawnRank = side === 'w' ? r + 1 : r - 1;
    for (const df of [-1, 1]) {
      const af = file(ep) + df;
      if (af < 0 || af > 7) continue;
      const p = board[square(af, pawnRank)];
      if (p && p.t === 'p' && p.c === side) return true;
    }
    return false;
  }

  private xorPiece(p: Piece, sq: number): void {
    const z = ZOBRIST[COLOR_INDEX[p.c]][TYPE_INDEX[p.t]][sq];
    this.hi = (this.hi ^ z[0]) >>> 0;
    this.lo = (this.lo ^ z[1]) >>> 0;
  }

  private xorCastle(before: CastlingRights, after: CastlingRights): void {
    const flip = (index: number) => {
      this.hi = (this.hi ^ Z_CASTLE[index][0]) >>> 0;
      this.lo = (this.lo ^ Z_CASTLE[index][1]) >>> 0;
    };
    if (before.wK !== after.wK) flip(0);
    if (before.wQ !== after.wQ) flip(1);
    if (before.bK !== after.bK) flip(2);
    if (before.bQ !== after.bQ) flip(3);
  }

  private xorEp(present: boolean, sq: number | null): void {
    if (!present || sq === null) return;
    const z = Z_EP[file(sq)];
    this.hi = (this.hi ^ z[0]) >>> 0;
    this.lo = (this.lo ^ z[1]) >>> 0;
  }

  /** Applies a move and updates the hash. The move MUST already be legal. */
  make(move: Move): void {
    const state = this.state;
    const board = state.board;
    const piece = board[move.from] as Piece;
    const mover = piece.c;

    const rightsBefore: CastlingRights = { ...state.castling };
    const epBefore = state.ep;
    const epBeforeReal = epBefore !== null && this.epIsReal();
    this.xorEp(epBeforeReal, epBefore);

    // Remove whatever is on the destination (en passant's victim is NOT on it).
    if (move.enPassant) {
      const victimSq = move.to + 8;
      const victim = board[victimSq];
      if (victim) this.xorPiece(victim, victimSq);
    } else {
      const taken = board[move.to];
      if (taken) this.xorPiece(taken, move.to);
    }

    this.xorPiece(piece, move.from);
    if (move.promotion) {
      const promoted: Piece = { t: move.promotion, c: mover };
      this.xorPiece(promoted, move.to);
    } else {
      this.xorPiece(piece, move.to);
    }

    // The rook leg of castling.
    if (move.castleKing) {
      const home = mover === 'w' ? 7 : 0;
      const rook = { t: 'r' as const, c: mover };
      this.xorPiece(rook, square(7, home));
      this.xorPiece(rook, square(5, home));
    } else if (move.castleQueen) {
      const home = mover === 'w' ? 7 : 0;
      const rook = { t: 'r' as const, c: mover };
      this.xorPiece(rook, square(0, home));
      this.xorPiece(rook, square(3, home));
    }

    this.hashStack.push(this.hi, this.lo);
    makeMove(state, move, this.stack);

    this.xorCastle(rightsBefore, state.castling);
    this.xorEp(state.ep !== null && this.epIsReal(), state.ep);
    this.hi = (this.hi ^ Z_SIDE[0]) >>> 0;
    this.lo = (this.lo ^ Z_SIDE[1]) >>> 0;
  }

  unmake(_move: Move): void {
    // The move itself is not needed: everything to restore is on the undo stack.
    // The parameter stays so the make/unmake calls read as a pair at the call
    // site, which is what makes a missing unmake visible when reading.
    unmakeMove(this.state, this.stack);
    this.hi = this.hashStack.pop() as number;
    this.lo = this.hashStack.pop() as number;
  }

  /**
   * A null move: the side to move "passes". It changes nothing except whose turn
   * it is, which is exactly what makes it useful for zugzwang and exactly what
   * makes it illegal to keep on the undo stack.
   */
  makeNull(): void {
    this.nullHashes.push(this.hi, this.lo);
    this.state.turn = opp(this.state.turn);
    this.hi = (this.hi ^ Z_SIDE[0]) >>> 0;
    this.lo = (this.lo ^ Z_SIDE[1]) >>> 0;
  }

  unmakeNull(): void {
    this.state.turn = opp(this.state.turn);
    this.lo = this.nullHashes.pop() as number;
    this.hi = this.nullHashes.pop() as number;
  }

  /** True if this exact position has already occurred on the current path. */
  repeated(): boolean {
    // Reversing hi/lo from the hash stack gives every earlier position without
    // maintaining a second array.
    const hi = this.hi;
    const lo = this.lo;
    const limit = Math.max(0, this.hashStack.length - this.state.halfmove * 2);
    for (let i = this.hashStack.length - 2; i >= limit; i -= 2) {
      if (this.hashStack[i] === hi && this.hashStack[i + 1] === lo) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * transposition table                                                 *
 * ------------------------------------------------------------------ */

const FLAG_EXACT = 0;
const FLAG_LOWER = 1;
const FLAG_UPPER = 2;

interface TTEntry {
  depth: number;
  score: number;
  flag: number;
  from: number;
  to: number;
  promo: number;
  /** Which search wrote it. Used to prefer deep entries over shallow ones. */
  gen: number;
}

class TranspositionTable {
  private readonly map = new Map<string, TTEntry>();
  private gen = 0;
  // A plain field rather than a TypeScript parameter property. Node's
  // type-stripping loader (which is how a test drives this exact module outside
  // a browser) rejects `constructor(private readonly x = 1)`, so the
  // shorthand would make this file unloadable outside a bundler.
  private readonly limit: number;

  constructor(limit = 1 << 19) {
    this.limit = limit;
  }

  newSearch(): void {
    this.gen++;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): TTEntry | undefined {
    return this.map.get(key);
  }

  /**
   * Depth-preferred with a simple age fallback: a deeper entry replaces a
   * shallower one outright; a same-depth entry only replaces one from an older
   * search. When the table fills, it is emptied rather than grown — a bounded
   * table cannot turn a memory leak into a stalled search.
   */
  put(key: string, entry: TTEntry): void {
    const existing = this.map.get(key);
    if (existing) {
      if (existing.depth > entry.depth && existing.gen === this.gen) return;
    } else if (this.map.size >= this.limit) {
      this.map.clear();
    }
    this.map.set(key, { ...entry, gen: this.gen });
  }

  clear(): void {
    this.map.clear();
  }
}

/* ------------------------------------------------------------------ *
 * move ordering                                                       *
 * ------------------------------------------------------------------ */

const TT_MOVE_SCORE = 3_000_000;
const CAPTURE_BASE = 1_000_000;
const KILLER_SCORE = 900_000;

/** What a move is worth to the side that has to live with it. */
function captureValue(move: Move, board: Board): number {
  let victim = 0;
  if (move.enPassant) victim = VALUE.p;
  else if (move.captured) victim = VALUE[move.captured];
  else {
    const target = board[move.to];
    if (target) victim = VALUE[target.t];
  }
  const attacker = board[move.from];
  const attackerValue = attacker ? ATTACK_VALUE[attacker.t] : 0;
  const promotion = move.promotion ? VALUE[move.promotion] - VALUE.p : 0;
  // MVV-LVA: take the biggest thing with the smallest thing.
  return victim * 16 - attackerValue + promotion;
}

function orderMoves(moves: Move[], scores: number[]): void {
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i];
    const s = scores[i];
    let j = i - 1;
    while (j >= 0 && scores[j] < s) {
      moves[j + 1] = moves[j];
      scores[j + 1] = scores[j];
      j--;
    }
    moves[j + 1] = m;
    scores[j + 1] = s;
  }
}

/* ------------------------------------------------------------------ *
 * cooperative yielding                                                *
 * ------------------------------------------------------------------ */

/**
 * How long the search may hold the thread before it lets queued work run.
 *
 * In a Worker this is what makes `stop` reachable: the search is one long
 * synchronous computation, and without a real yield the `message` event carrying
 * the stop request cannot be delivered until the search has already finished.
 */
export const SLICE_MS = 10;

/**
 * Hands control back to the event loop, as a MACROTASK.
 *
 * This function is load-bearing and was wrong once already. It has to hand back
 * to the *whole* event loop — timers, message events and rendering — not just to
 * the microtask queue.
 *
 *   - `await Promise.resolve()` drains microtasks and returns control to exactly
 *     the same starved loop. Useless.
 *   - A `MessageChannel` round trip is the fashionable answer, and it is ~8x
 *     faster than a timer. It is also WRONG: a tight port-message loop starves
 *     the timer queue completely. Measured here — a `setTimeout(…, 5)` scheduled
 *     alongside a 15-second search fired ONCE, at the end. A `stop` request that
 *     arrives as a task behind an endless port-message stream is a cancel button
 *     that does not cancel, which is worse than not having one.
 *
 * So: `setTimeout(0)`, which is fair to every task source, on every engine that
 * has timers. It costs roughly 1.3ms per yield instead of 0.15ms. At one yield
 * per 10ms slice that is about 12% of the wall clock, which is a real cost and is
 * paid deliberately: a search that is 12% slower and can actually be stopped is
 * worth more than one that is faster and ignores you.
 *
 * `MessageChannel` remains the fallback for an environment with no timers at all,
 * which is not a real browser but is a real test harness.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof setTimeout === 'function') {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (typeof MessageChannel !== 'undefined') {
    const { port1, port2 } = new MessageChannel();
    port1.start();
    port2.start();
    return new Promise<void>((resolve) => {
      port1.addEventListener('message', () => resolve(), { once: true });
      port2.postMessage(0);
    });
  }
  // Nothing to yield with. Returning here keeps the search correct rather than
  // cancellable, which is the lesser failure.
  return Promise.resolve();
}

/* ------------------------------------------------------------------ *
 * searcher                                                            *
 * ------------------------------------------------------------------ */

/** Thrown to unwind the whole tree the moment a budget is exhausted. */
const ABORT = Symbol('abort');

export interface SearchProgress {
  depth: number;
  score: number;
  nodes: number;
  ms: number;
  pv: string[];
}

export interface SearchOptions {
  level?: EngineLevel;
  budget?: Partial<SearchBudget>;
  /** Cooperative cancellation. Set `.aborted = true` to stop as soon as possible. */
  signal?: { aborted: boolean };
  onProgress?: (progress: SearchProgress) => void;
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Seeds the low-level "pick something near-best" draw. */
  seed?: number;
}

export interface SearchResult {
  /** null when the side to move has no legal move (mate or stalemate). */
  move: Move | null;
  san: string | null;
  /** Centipawns from the side-to-move's point of view. */
  score: number;
  /** Positive = the side to move mates in N moves, negative = is mated in N. */
  mate: number | null;
  /** Deepest iteration that completed. */
  depth: number;
  nodes: number;
  ms: number;
  pv: string[];
  /** True when a budget or an abort cut the search short. */
  truncated: boolean;
  level: EngineLevel;
  /** Whether the side to move was in check when the search started. */
  inCheck: boolean;
}

class Searcher {
  private readonly pos: Position;
  private readonly budget: SearchBudget;
  private readonly level: EngineLevel;
  private readonly now: () => number;
  private readonly start: number;
  private readonly signal: { aborted: boolean } | undefined;
  private readonly onProgress: ((p: SearchProgress) => void) | undefined;
  private readonly tt = new TranspositionTable();
  private readonly history = new Int32Array(2 * 4096);
  private readonly killers: Int32Array[] = [];
  private readonly seed: number;
  private randomState: number;

  nodes = 0;
  private lastYield = 0;
  private best: Move | null = null;
  private readonly rootMoves: Move[];
  private rootScores = new Map<string, { score: number; move: Move }>();
  private prevScore: number | null = null;
  private completedDepth = 0;
  private rootPv: string[] = [];

  constructor(state: GameState, budget: SearchBudget, opts: SearchOptions, level: EngineLevel) {
    this.pos = new Position(state);
    this.budget = budget;
    this.level = level;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.start = this.now();
    this.lastYield = this.start;
    this.signal = opts.signal;
    this.onProgress = opts.onProgress;
    this.seed = (opts.seed ?? 0x9e3779b9) >>> 0;
    this.randomState = this.seed || 1;
    for (let i = 0; i < MAX_PLY; i++) this.killers.push(new Int32Array(2));
    this.rootMoves = legalMoves(cloneState(state));
  }

  private rand(): number {
    // xorshift32, so a given seed always produces the same "random" game.
    let s = this.randomState;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    this.randomState = s >>> 0;
    return this.randomState / 0xffffffff;
  }

  /** Budget check + event-loop yield. Called once every 1024 nodes. */
  private async tick(): Promise<void> {
    if ((this.nodes & 1023) !== 0) return;
    if (this.signal?.aborted) throw ABORT;
    const t = this.now();
    if (t - this.start >= this.budget.timeMs) throw ABORT;
    if (this.nodes >= this.budget.maxNodes) throw ABORT;
    if (t - this.lastYield >= SLICE_MS) {
      this.lastYield = t;
      await yieldToEventLoop();
      if (this.signal?.aborted) throw ABORT;
    }
  }

  private scoreToTT(score: number, ply: number): number {
    if (score > MATE_BOUND) return score + ply;
    if (score < -MATE_BOUND) return score - ply;
    return score;
  }

  private scoreFromTT(score: number, ply: number): number {
    if (score > MATE_BOUND) return score - ply;
    if (score < -MATE_BOUND) return score + ply;
    return score;
  }

  /** Legal moves for `state`, on a copy — the engine mutates while generating. */
  private legal(state: GameState): Move[] {
    return legalMoves(cloneState(state));
  }

  /**
   * `evaluate()` is white-centric (it has to be: the piece-square tables are).
   * Negamax is not. Every score crossing that boundary goes through here, and
   * forgetting it once means the engine plays its opponent's game.
   */
  private evalSideToMove(): number {
    const e = evaluate(this.pos.state);
    return this.pos.state.turn === 'w' ? e : -e;
  }

  private order(state: GameState, moves: Move[], ply: number, ttEntry: TTEntry | undefined, scores: number[]): void {
    const board = state.board;
    const k0 = ply < MAX_PLY ? this.killers[ply][0] : 0;
    const k1 = ply < MAX_PLY ? this.killers[ply][1] : 0;
    const colorIndex = state.turn === 'w' ? 0 : 1;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (ttEntry && ttEntry.from === move.from && ttEntry.to === move.to) {
        scores[i] = TT_MOVE_SCORE;
        continue;
      }
      if (move.captured || move.enPassant || move.promotion) {
        scores[i] = CAPTURE_BASE + captureValue(move, board);
        continue;
      }
      const kIdx = move.from * 64 + move.to;
      if (k0 === kIdx) scores[i] = KILLER_SCORE + 1;
      else if (k1 === kIdx) scores[i] = KILLER_SCORE;
      else scores[i] = Math.max(0, this.history[colorIndex * 4096 + kIdx]);
    }
    orderMoves(moves, scores);
  }

  private recordKiller(ply: number, move: Move): void {
    if (ply >= MAX_PLY) return;
    const idx = move.from * 64 + move.to;
    const slot = this.killers[ply];
    if (slot[0] !== idx) {
      slot[1] = slot[0];
      slot[0] = idx;
    }
  }

  private bumpHistory(move: Move, depth: number): void {
    const colorIndex = this.pos.state.turn === 'w' ? 0 : 1;
    const idx = colorIndex * 4096 + move.from * 64 + move.to;
    this.history[idx] += depth * depth;
    if (this.history[idx] > 1 << 20) {
      // Halve the whole table rather than the single entry: an entry that keeps
      // its own high value is a bug, not a feature.
      for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1;
    }
  }

  /**
   * Quiescence. Stand pat, then resolve captures only.
   *
   * Without this, a depth-4 search cannot see that the queen it is about to
   * capture onto is defended by a pawn, so it wins material in its own eval and
   * then blunders it back. That failure is called a horizon effect and it is
   * exactly what "the engine does not blunder into captures" means.
   */
  private async quiesce(alpha: number, beta: number, ply: number): Promise<number> {
    this.nodes++;
    await this.tick();
    if (ply >= MAX_PLY - 2) return this.evalSideToMove();

    if (this.pos.state.halfmove >= 100) return 0;
    if (this.pos.repeated()) return 0;

    const checked = inCheck(this.pos.state, this.pos.state.turn);
    const stand = this.evalSideToMove();

    if (!checked) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
    }

    const candidates = checked ? this.legal(this.pos.state) : this.quiesceLegal();
    if (candidates.length === 0) return checked ? -MATE_SCORE + ply : alpha;

    const scores = new Array<number>(candidates.length).fill(0);
    this.order(this.pos.state, candidates, ply, undefined, scores);

    let best = alpha;
    for (let i = 0; i < candidates.length; i++) {
      const move = candidates[i];
      // Delta pruning: if even winning this piece for free cannot reach alpha,
      // no continuation through it will either.
      if (!checked && stand + captureValue(move, this.pos.state.board) + 200 < alpha) continue;

      this.pos.make(move);
      let score: number;
      try {
        score = -(await this.quiesce(-beta, -alpha, ply + 1));
      } finally {
        this.pos.unmake(move);
      }

      if (score >= beta) return score;
      if (score > best) best = score;
    }
    return best;
  }

  /** Captures and promotions only, filtered for legality. */
  private quiesceLegal(): Move[] {
    const state = this.pos.state;
    const out: Move[] = [];
    const history: UndoStack = [];
    for (const move of pseudoLegalMoves(state)) {
      if (!move.captured && !move.enPassant && !move.promotion) continue;
      makeMove(state, move, history);
      const ok = !inCheck(state, opp(state.turn));
      unmakeMove(state, history);
      if (ok) out.push(move);
    }
    return out;
  }

  private hasNonPawnMaterial(color: Color): boolean {
    const board = this.pos.state.board;
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (p && p.c === color && (p.t === 'n' || p.t === 'b' || p.t === 'r' || p.t === 'q')) return true;
    }
    return false;
  }

  private async negamax(depth: number, alphaIn: number, beta: number, ply: number, allowNull: boolean): Promise<number> {
    let alpha = alphaIn;
    this.nodes++;
    await this.tick();

    if (ply >= MAX_PLY - 2) return evaluate(this.pos.state);
    if (this.pos.state.halfmove >= 100) return 0;
    if (this.pos.repeated()) return 0;

    const state = this.pos.state;
    // Named `checked`, not `inCheck`: a local `const inCheck = inCheck(...)`
    // shadows the imported function inside its own initialiser, which is a
    // temporal dead zone reference and throws the first time a node is searched.
    const checked = inCheck(state, state.turn);
    // A forced check is worth one more ply of search; this is what finds the
    // mating net one move earlier than a flat depth would.
    const effective = checked ? depth + 1 : depth;
    if (effective <= 0) return await this.quiesce(alpha, beta, ply);

    const alphaOrig = alpha;
    const key = keyOf(this.pos.hi, this.pos.lo);
    const entry = this.tt.get(key);
    if (entry) {
      if (entry.depth >= effective) {
        const stored = this.scoreFromTT(entry.score, ply);
        if (entry.flag === FLAG_EXACT) return stored;
        if (entry.flag === FLAG_LOWER && stored > alpha) alpha = stored;
        else if (entry.flag === FLAG_UPPER && stored < beta) beta = stored;
        if (alpha >= beta) return stored;
      }
    }

    // Null-move pruning: give the opponent a free move; if the position is still
    // good enough to fail high, it was never in danger. Disabled when in check
    // (the opponent would simply check back) and when the side to move has
    // nothing but pawns (classic zugzwang).
    if (allowNull && !checked && effective >= 3 && this.hasNonPawnMaterial(state.turn)) {
      const reduction = effective > 6 ? 3 : 2;
      this.pos.makeNull();
      let score: number;
      try {
        score = -(await this.negamax(effective - 1 - reduction, -beta, -beta + 1, ply + 1, false));
      } finally {
        this.pos.unmakeNull();
      }
      if (score >= beta) return beta;
    }

    const moves = this.legal(state);
    if (moves.length === 0) return -MATE_SCORE + ply;

    const scores = new Array<number>(moves.length).fill(0);
    this.order(state, moves, ply, entry, scores);

    let best = -INFINITY;
    let bestMove: Move | null = null;

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      const isQuiet = !move.captured && !move.enPassant && !move.promotion;

      // Late move reductions: a quiet move ordered this far down the list is
      // unlikely to be the best move, so look at it shallower. Skipped in check
      // and at shallow depth, where it costs more than it saves.
      let reduction = 0;
      if (isQuiet && effective >= 3 && i >= 4 && !checked) {
        reduction = effective >= 6 ? 2 : 1;
        if (i >= 12) reduction += 1;
      }

      this.pos.make(move);
      let score: number;
      try {
        const extDepth = effective - 1 - reduction;
        // Late move reductions can go negative at the horizon; searching there
        // means a full quiescence, which is what actually stops the horizon
        // bug — so allow it rather than clamping.
        score = i === 0
          ? -(await this.negamax(extDepth, -beta, -alpha, ply + 1, true))
          : -(await this.negamax(extDepth, -alpha - 1, -alpha, ply + 1, true));
      } finally {
        this.pos.unmake(move);
      }

      if (score > best) {
        best = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          // Fail high: this move is too good to be refuted at this depth.
          this.tt.put(key, {
            depth: effective,
            score: this.scoreToTT(score, ply),
            flag: FLAG_LOWER,
            from: bestMove.from,
            to: bestMove.to,
            promo: bestMove.promotion ? TYPE_INDEX[bestMove.promotion] : -1,
            gen: 0,
          });
          return score;
        }
      }

      // A quiet move that caused a cut-off somewhere below is worth trying early
      // next time.
      if (score <= alphaOrig && isQuiet) {
        this.recordKiller(ply, move);
        this.bumpHistory(move, effective);
      }
    }

    const stored = this.scoreToTT(best, ply);
    const flag = best <= alphaOrig ? FLAG_UPPER : FLAG_EXACT;
    this.tt.put(key, {
      depth: effective,
      score: stored,
      flag,
      from: bestMove ? bestMove.from : -1,
      to: bestMove ? bestMove.to : -1,
      promo: bestMove && bestMove.promotion ? TYPE_INDEX[bestMove.promotion] : -1,
      gen: 0,
    });
    return best;
  }

  /** One root move. Separate from negamax so the root can keep per-move scores. */
  private async searchRoot(move: Move, depth: number, alpha: number, beta: number): Promise<number> {
    this.pos.make(move);
    let score: number;
    try {
      score = -(await this.negamax(depth - 1, -beta, -alpha, 1, true));
    } finally {
      this.pos.unmake(move);
    }
    return score;
  }

  /**
   * One iterative-deepening pass over every root move.
   *
   * With an aspiration window after depth 3, and exactly ONE bounded widening if
   * the window fails — a window that is re-widened in a loop is a search that
   * can spin forever, which is how a "fast" engine becomes a hung CI job.
   */
  private async iterate(depth: number, ordered: Move[]): Promise<void> {
    let alpha = -INFINITY;
    let beta = INFINITY;
    if (depth >= 4 && this.prevScore !== null) {
      alpha = this.prevScore - 48;
      beta = this.prevScore + 48;
    }

    for (let pass = 0; pass < 2; pass++) {
      // Re-order by the previous iteration's scores so the best move is first.
      const scores = new Array<number>(ordered.length).fill(0);
      const prev = this.rootScores;
      const board = this.pos.state.board;
      for (let i = 0; i < ordered.length; i++) {
        const m = ordered[i];
        // Deliberately on the same (small) scale as real scores, so a searched
        // move from the last iteration always outranks an unsearched one.
        scores[i] = prev.get(moveKey(m))?.score ?? captureValue(m, board);
      }
      const list = ordered.slice();
      orderMoves(list, scores);

      let best: Move | null = null;
      let bestScore = -INFINITY;
      const round = new Map<string, { score: number; move: Move }>();

      for (let i = 0; i < list.length; i++) {
        const move = list[i];
        const score = await this.searchRoot(move, depth, alpha, beta);
        round.set(moveKey(move), { score, move });
        if (score > bestScore) {
          bestScore = score;
          best = move;
        }
        if (score > alpha) alpha = score;
      }

      this.rootScores = round;
      this.best = best;
      this.completedDepth = depth;
      this.rootPv = this.extractPv(best);

      if (alpha < beta || pass === 1) {
        this.prevScore = bestScore;
        return;
      }
      // Fail high. Search again once with no window at all.
      alpha = -INFINITY;
      beta = INFINITY;
    }
  }

  /**
   * Walks the transposition table's best-move chain into SAN.
   *
   * This needs its OWN Position: the searcher's hash has already unwound back
   * to the root, so following the chain against `this.pos` would read the same
   * table entry for every ply and print a line of the same move.
   */
  private extractPv(best: Move | null): string[] {
    const out: string[] = [];
    if (!best) return out;
    const walker = new Position(cloneState(this.pos.state));
    let move = best;
    for (let i = 0; i < 10; i++) {
      const legal = this.legal(walker.state);
      const found = legal.find((m) => m.from === move.from && m.to === move.to);
      if (!found) break;
      out.push(toSAN(walker.state, found));
      walker.make(found);
      // A PV that stops in the middle of a check is not worth printing further.
      if (inCheck(walker.state, walker.state.turn)) break;
      const entry = this.tt.get(keyOf(walker.hi, walker.lo));
      if (!entry || entry.from < 0) break;
      const next = legalMoves(cloneState(walker.state)).find((m) => m.from === entry.from && m.to === entry.to);
      if (!next) break;
      move = next;
    }
    return out;
  }

  async run(): Promise<SearchResult> {
    const startState = this.pos.state;
    const wasInCheck = inCheck(startState, startState.turn);
    const ms = () => this.now() - this.start;

    if (this.rootMoves.length === 0) {
      return {
        move: null,
        san: null,
        score: wasInCheck ? -MATE_SCORE : 0,
        mate: wasInCheck ? 0 : null,
        depth: 0,
        nodes: 0,
        ms: ms(),
        pv: [],
        truncated: false,
        level: this.level,
        inCheck: wasInCheck,
      };
    }

    // Safety net: if the very first iteration is cut short by the budget we
    // still return a legal move rather than nothing.
    const ordered = this.rootMoves.slice();
    this.order(startState, ordered, 0, undefined, new Array<number>(ordered.length).fill(0));
    this.best = ordered[0];

    this.tt.newSearch();
    let truncated = false;

    for (let depth = 1; depth <= this.budget.maxDepth; depth++) {
      try {
        await this.iterate(depth, ordered);
      } catch (err) {
        if (err !== ABORT) throw err;
        truncated = true;
        break;
      }
      const bestScore = this.rootScores.get(moveKey(this.best as Move))?.score ?? 0;
      this.onProgress?.({
        depth,
        score: bestScore,
        nodes: this.nodes,
        ms: ms(),
        pv: this.rootPv,
      });
      // A proven forced mate is exact: going deeper cannot improve it, and
      // stopping here is the difference between "fast" and "stares at the board".
      if (bestScore > MATE_BOUND && depth >= 2) {
        truncated = depth < this.budget.maxDepth;
        break;
      }
      if (this.now() - this.start >= this.budget.timeMs || this.nodes >= this.budget.maxNodes) {
        truncated = true;
        break;
      }
    }

    let chosen = this.best;
    if (chosen && this.budget.randomness > 0 && this.rootScores.size > 1) {
      const bestEntry = this.rootScores.get(moveKey(chosen));
      if (bestEntry) {
        const threshold = bestEntry.score - this.budget.randomness;
        const pool: Move[] = [];
        for (const entry of this.rootScores.values()) if (entry.score >= threshold) pool.push(entry.move);
        if (pool.length > 0) chosen = pool[Math.floor(this.rand() * pool.length) % pool.length];
      }
    }

    const score = chosen ? this.rootScores.get(moveKey(chosen))?.score ?? 0 : 0;
    const mateFromScore = (s: number): number | null => {
      if (s > MATE_BOUND) return Math.ceil((MATE_SCORE - s) / 2);
      if (s < -MATE_BOUND) return -Math.ceil((MATE_SCORE + s) / 2);
      return null;
    };

    return {
      move: chosen,
      san: chosen ? toSAN(startState, chosen) : null,
      score,
      mate: mateFromScore(score),
      depth: this.completedDepth,
      nodes: this.nodes,
      ms: ms(),
      pv: this.extractPv(chosen),
      truncated,
      level: this.level,
      inCheck: wasInCheck,
    };
  }
}

const moveKey = (move: Move): string => `${move.from}:${move.to}:${move.promotion ?? ''}`;

/**
 * Searches the position and returns the side-to-move's best move.
 *
 * Never throws for budget reasons — a truncated search is a *valid* result, not
 * a failure, and the UI must be able to show a move the instant one exists.
 */
export async function bestMove(state: GameState, options: SearchOptions = {}): Promise<SearchResult> {
  const level = options.level ?? 'club';
  const budget = budgetFor(level, options.budget);
  const searcher = new Searcher(cloneState(state), budget, options, level);
  return searcher.run();
}

/* ------------------------------------------------------------------ *
 * engine client (Worker, with a stated fallback)                      *
 * ------------------------------------------------------------------ */

export type EngineTransport = 'worker' | 'main-thread';

export interface ChessEngine {
  transport: EngineTransport;
  /** Non-null when we are NOT running in a Worker, saying exactly why. */
  degradation: string | null;
  /** The level the engine will use, which the fallback may lower. */
  level: EngineLevel;
  busy: boolean;
  bestMove: (state: GameState, level?: EngineLevel) => Promise<SearchResult>;
  /** Asks the search to stop. Resolves the in-flight promise with what it has. */
  stop: () => void;
  /** Hard stop: kills the Worker. Always safe to call. */
  dispose: () => void;
}

export type EngineRequest =
  | { type: 'search'; id: number; state: GameState; level: EngineLevel; budget?: Partial<SearchBudget> }
  | { type: 'stop' };

export type EngineResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: number; depth: number; score: number; nodes: number; ms: number; pv: string[] }
  | { type: 'result'; id: number; result: SearchResult }
  | { type: 'error'; id: number; message: string };

/** True when this environment can construct a module Worker at all. */
export function workerAvailable(): boolean {
  return typeof Worker === 'function';
}

interface Pending {
  resolve: (result: SearchResult) => void;
  reject: (err: Error) => void;
  /** The flag the search is watching. Set `.aborted` to stop it. */
  signal: { aborted: boolean };
}

export interface ChessEngineOptions {
  level?: EngineLevel;
  /** Called once per completed iteration. Never called after `dispose()`. */
  onProgress?: (progress: SearchProgress) => void;
}

/**
 * Lazily spawns `../chess.worker.ts` and forwards searches to it.
 *
 * The fallback is not "pretend there is no opponent": it runs the SAME search
 * on the main thread with a much smaller budget, and it says so through
 * `degradation`, so the UI can show the truth rather than silently serving a
 * worse game without explanation.
 *
 * The fallback search is still *cancellable* — the cooperative yields in
 * `Searcher.tick` work the same on a thread with nothing else on it — but it
 * competes with rendering for that thread, which is exactly why it is a
 * degraded mode and not the default.
 */
export function createChessEngine(options: ChessEngineOptions = {}): ChessEngine {
  let level: EngineLevel = options.level ?? 'club';
  let worker: Worker | null = null;
  let workerFailed = false;
  let nextId = 1;
  let busy = false;
  const pending = new Map<number, Pending>();
  let degradation: string | null = null;
  // The abort flag of whichever search is running. Held separately from
  // `pending` because the main-thread fallback has a live promise but no entry
  // in that map — and `stop()` has to reach both, or cancel would work in the
  // Worker and silently do nothing in the degraded path.
  let activeSignal: { aborted: boolean } | null = null;

  const ensureWorker = (): Worker | null => {
    if (workerFailed) return null;
    if (worker) return worker;
    if (!workerAvailable()) {
      workerFailed = true;
      degradation =
        'This browser cannot create Web Workers, so the engine is searching on the main thread with a ' +
        `smaller budget (depth ${FALLBACK_BUDGET.maxDepth}).`;
      return null;
    }
    try {
      worker = new Worker(new URL('../chess.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      workerFailed = true;
      degradation =
        'The Worker was blocked (a Content-Security-Policy without worker-src, or a file:// page). ' +
        `The engine is searching on the main thread with a smaller budget (depth ${FALLBACK_BUDGET.maxDepth}). ` +
        `(${(err as Error)?.message ?? 'no detail'})`;
      return null;
    }

    worker.onmessage = (event: MessageEvent<EngineResponse>) => {
      const msg = event.data;
      if (msg.type === 'ready') return;
      if (msg.type === 'progress') {
        // Progress is only ever interesting for the search we are waiting on.
        // A late progress frame from a search whose result already landed must
        // not paint the UI with a depth belonging to a previous position.
        if (msg.id === inFlightId) options.onProgress?.(msg);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (inFlightId === msg.id) {
        inFlightId = 0;
        busy = false;
        activeSignal = null;
      }
      if (msg.type === 'error') entry.reject(new Error(msg.message));
      else entry.resolve(msg.result);
    };

    worker.onerror = (event: Event) => {
      const message = (event as ErrorEvent).message || 'the engine worker crashed';
      workerFailed = true;
      worker = null;
      degradation = `The engine worker stopped (${message}). Searching on the main thread with a smaller budget.`;
      for (const [, entry] of pending) entry.reject(new Error(message));
      pending.clear();
      inFlightId = 0;
      busy = false;
      activeSignal = null;
    };

    return worker;
  };

  // Declared here and referenced by the closures above, which is why it is a
  // `let` assigned below rather than a `const`: `onmessage` is installed inside
  // `ensureWorker`, which runs before this line on the very first call.
  let inFlightId = 0;

  return {
    get transport(): EngineTransport {
      // Keyed on `workerFailed` alone, not on `worker`: the Worker is created
      // lazily on the first search, so a freshly constructed engine has none yet
      // and reporting 'main-thread' before anything has run would be a lie about
      // a fallback that has not happened.
      return workerFailed ? 'main-thread' : 'worker';
    },
    get degradation() {
      return degradation;
    },
    get level() {
      return level;
    },
    set level(next: EngineLevel) {
      level = next;
    },
    get busy() {
      return busy;
    },

    bestMove: async (state: GameState, requested?: EngineLevel) => {
      const useLevel = requested ?? level;
      const w = ensureWorker();

      if (!w) {
        // Degraded path. The signal is registered so `stop()` reaches it — a
        // cancel that only worked in the Worker would be a cancel that silently
        // does nothing in exactly the situation a user is most likely to need it.
        busy = true;
        const signal = { aborted: false };
        activeSignal = signal;
        try {
          return await bestMove(state, {
            level: useLevel,
            budget: FALLBACK_BUDGET,
            signal,
            onProgress: options.onProgress,
          });
        } finally {
          busy = false;
          if (activeSignal === signal) activeSignal = null;
        }
      }

      const id = nextId++;
      busy = true;
      inFlightId = id;
      const signal = { aborted: false };
      activeSignal = signal;
      return new Promise<SearchResult>((resolve, reject) => {
        const entry: Pending = { resolve, reject, signal };
        pending.set(id, entry);
        // `cloneState` before posting: postMessage structured-clones, which is
        // a snapshot — but the caller's board keeps mutating while the opponent
        // "thinks", and the search must not see those edits.
        w.postMessage({ type: 'search', id, state: cloneState(state), level: useLevel } satisfies EngineRequest);
      });
    },

    stop: () => {
      if (activeSignal) activeSignal.aborted = true;
      if (worker && inFlightId) worker.postMessage({ type: 'stop' } satisfies EngineRequest);
    },

    dispose: () => {
      // Abort before rejecting: the in-flight search holds a promise that will
      // never settle otherwise, and a terminated Worker cannot be asked to stop.
      workerFailed = true;
      if (activeSignal) activeSignal.aborted = true;
      activeSignal = null;
      for (const [, entry] of pending) entry.reject(new Error('engine disposed'));
      pending.clear();
      inFlightId = 0;
      busy = false;
      if (worker) {
        worker.terminate();
        worker = null;
      }
    },
  };
}

/** Convenience for callers that just want one move. */
export async function engineBestMove(state: GameState, level: EngineLevel = 'club'): Promise<SearchResult> {
  return bestMove(state, { level });
}
