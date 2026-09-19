// ponytail: tiny chess engine — minimax + alpha-beta, depth 2-3, no castling/en passant
export type Color = 'w' | 'b';
export type PType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece {
  t: PType;
  c: Color;
}
export type Board = (Piece | null)[];
export interface Move {
  from: number;
  to: number;
  promo?: PType;
}

const VAL: Record<PType, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const OPP: Record<Color, Color> = { w: 'b', b: 'w' };
const KNIGHT: Array<[number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const DIAG: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const on = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;

export function initialBoard(): Board {
  const back: PType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const b: Board = Array(64).fill(null);
  for (let c = 0; c < 8; c++) {
    b[c] = { t: back[c], c: 'b' };
    b[8 + c] = { t: 'p', c: 'b' };
    b[48 + c] = { t: 'p', c: 'w' };
    b[56 + c] = { t: back[c], c: 'w' };
  }
  return b;
}

function slide(b: Board, i: number, dirs: Array<[number, number]>, capsOnly: boolean, out: Move[]) {
  const r0 = Math.floor(i / 8);
  const c0 = i % 8;
  const me = b[i]!;
  for (const [dr, dc] of dirs) {
    let r = r0 + dr;
    let c = c0 + dc;
    while (on(r, c)) {
      const j = r * 8 + c;
      const t = b[j];
      if (!t) {
        if (!capsOnly) out.push({ from: i, to: j });
      } else {
        if (t.c !== me.c) out.push({ from: i, to: j });
        break;
      }
      if (t) break;
      r += dr;
      c += dc;
    }
  }
}

export function pseudoMoves(b: Board, i: number, capsOnly = false): Move[] {
  const p = b[i];
  if (!p) return [];
  const out: Move[] = [];
  const r = Math.floor(i / 8);
  const c = i % 8;
  if (p.t === 'p') {
    const dir = p.c === 'w' ? -1 : 1;
    const last = p.c === 'w' ? 0 : 7;
    const start = p.c === 'w' ? 6 : 1;
    for (const dc of [-1, 1]) {
      const rr = r + dir;
      const cc = c + dc;
      if (on(rr, cc)) {
        const t = b[rr * 8 + cc];
        if (t && t.c !== p.c) out.push({ from: i, to: rr * 8 + cc, promo: rr === last ? 'q' : undefined });
      }
    }
    if (!capsOnly) {
      const one = r + dir;
      if (on(one, c) && !b[one * 8 + c]) {
        out.push({ from: i, to: one * 8 + c, promo: one === last ? 'q' : undefined });
        const two = r + 2 * dir;
        if (r === start && !b[two * 8 + c]) out.push({ from: i, to: two * 8 + c });
      }
    }
  } else if (p.t === 'n' || p.t === 'k') {
    for (const [dr, dc] of p.t === 'n' ? KNIGHT : KING) {
      const rr = r + dr;
      const cc = c + dc;
      if (!on(rr, cc)) continue;
      const t = b[rr * 8 + cc];
      if (!t) {
        if (!capsOnly) out.push({ from: i, to: rr * 8 + cc });
      } else if (t.c !== p.c) out.push({ from: i, to: rr * 8 + cc });
    }
  } else {
    slide(b, i, p.t === 'b' ? DIAG : p.t === 'r' ? ORTH : [...DIAG, ...ORTH], capsOnly, out);
  }
  return out;
}

export function attacked(b: Board, sq: number, by: Color): boolean {
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (p && p.c === by && pseudoMoves(b, i, true).some((m) => m.to === sq)) return true;
  }
  return false;
}

function kingSq(b: Board, c: Color): number {
  return b.findIndex((p) => p && p.t === 'k' && p.c === c);
}

export function inCheck(b: Board, c: Color): boolean {
  return attacked(b, kingSq(b, c), OPP[c]);
}

export function legalMoves(b: Board, c: Color): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.c !== c) continue;
    for (const m of pseudoMoves(b, i)) {
      const nb = applyMove(b, m);
      if (!attacked(nb, kingSq(nb, c), OPP[c])) out.push(m);
    }
  }
  return out;
}

export function applyMove(b: Board, m: Move): Board {
  const nb = b.slice();
  const p = nb[m.from]!;
  nb[m.to] = { t: m.promo ?? p.t, c: p.c };
  nb[m.from] = null;
  return nb;
}

export function evaluate(b: Board): number {
  let s = 0;
  for (const p of b) if (p) s += (p.c === 'w' ? 1 : -1) * VAL[p.t];
  return s;
}

function search(b: Board, turn: Color, depth: number, alpha: number, beta: number): number {
  const moves = legalMoves(b, turn);
  if (!moves.length) return inCheck(b, turn) ? (turn === 'w' ? -99999 : 99999) : 0;
  if (depth === 0) return evaluate(b);
  if (turn === 'w') {
    let best = -Infinity;
    for (const m of moves) {
      best = Math.max(best, search(applyMove(b, m), 'b', depth - 1, alpha, beta));
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    best = Math.min(best, search(applyMove(b, m), 'w', depth - 1, alpha, beta));
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

export function bestMove(b: Board, turn: Color): Move | null {
  const moves = legalMoves(b, turn);
  if (!moves.length) return null;
  const depth = b.filter(Boolean).length > 20 ? 2 : 3;
  const ordered = [...moves].sort((x, y) => (b[y.to] ? 1 : 0) - (b[x.to] ? 1 : 0));
  let best = ordered[0];
  let bs = turn === 'w' ? -Infinity : Infinity;
  for (const m of ordered) {
    const s = search(applyMove(b, m), OPP[turn], depth - 1, -Infinity, Infinity);
    if ((turn === 'w' && s > bs) || (turn === 'b' && s < bs)) {
      bs = s;
      best = m;
    }
  }
  return best;
}

export const GLYPH: Record<Color, Record<PType, string>> = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};
