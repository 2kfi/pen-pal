import { describe, it, expect } from 'vitest';
import {
  cloneState,
  gameResult,
  inCheck,
  initialState,
  legalMoves,
  makeMove,
  toSAN,
  type GameState,
  type Move,
} from './chessEngine';
import { uciOf, type SealedMove } from './chessGames';
import { pgnResult, pgnMovetext, toPgn, wrapMovetext, namesFor, pgnFilename } from './pgn';

type Stack = Parameters<typeof makeMove>[2];

/**
 * Build a real move list through the engine, so the export is tested against a
 * game that actually happened rather than against fixtures someone typed.
 */
function recordOf(algebraic: string[]): SealedMove[] {
  let state: GameState = initialState();
  const history: Stack = [];
  const moves: SealedMove[] = [];

  algebraic.forEach((token, index) => {
    const names = token.match(/[a-h][1-8]/g) ?? [];
    if (names.length < 2) throw new Error(`\`${token}\` is not a from-to pair`);
    const at = (name: string) => name.charCodeAt(0) - 97 + (8 - Number(name.charAt(1))) * 8;
    const from = at(names[0]!);
    const to = at(names[1]!);
    const promo: string | undefined = token[4];
    const found = legalMoves(state).find(
      (m) => m.from === from && m.to === to && (m.promotion ?? undefined) === (promo || undefined),
    );
    if (!found) throw new Error(`${token} is not legal at ply ${index + 1}`);

    moves.push({
      ply: index + 1,
      color: state.turn,
      san: toSAN(state, found as Move),
      uci: uciOf(found),
      at: new Date(2026, 0, 15, 12, index).toISOString(),
    });

    makeMove(state, found, history);
  });

  return moves;
}

/** Fool's mate: 1. f3 e5 2. g4 Qh4#. */
const CHECKMATED = recordOf(['f2f3', 'e7e5', 'g2g4', 'd8h4']);

describe('PGN export', () => {
  it('writes a header a parser accepts', () => {
    const pgn = toPgn(
      { status: 'checkmate', winnerId: 2, whiteId: 1, blackId: 2, createdAt: '2026-10-15T20:04:00.000Z' },
      CHECKMATED,
      { white: 'Ada', black: 'Margot' },
      { site: 'penpal.invalid' },
    );

    expect(pgn).not.toBeNull();
    const lines = pgn!.split('\n');

    expect(lines[0]).toBe('[Event "PenPal correspondence"]');
    expect(lines[1]).toBe('[Site "penpal.invalid"]');
    expect(lines[2]).toBe('[Date "2026.10.15"]');
    expect(lines[4]).toBe('[White "Ada"]');
    expect(lines[5]).toBe('[Black "Margot"]');
    expect(lines[6]).toBe('[Result "0-1"]');

    // A blank line after the header is what separates tags from movetext. Every
    // PGN reader depends on it, and a file missing it loads as an empty game.
    expect(lines[7]).toBe('');

    const body = pgn!.split('\n\n').slice(1).join('\n\n').trim();
    expect(body.endsWith('0-1')).toBe(true);
  });

  it('recovers the mate marker, which the engine does not carry', () => {
    // The engine's toSAN has no '#'. A PGN without it is a different game to
    // every program that reads the file, so this is the assertion that matters
    // most in this file.
    const { text } = pgnMovetext(CHECKMATED);
    expect(text).toBe('1. f3 e5 2. g4 Qh4#');
  });

  it('recovers a check marker without claiming mate', () => {
    // Find a checking move rather than writing one out by hand.
    //
    // Three hand-written lines were wrong in a row: 2. Qh5 is not check, Bc5
    // is blocked by the d6 pawn, and Bf4 is blocked by the f2 pawn. A test that
    // asserts a falsehood about chess passes for the wrong reason, which is
    // worse than no test at all. This one plays a real opening and then asks the
    // rules engine which of its legal moves gives check, so the only claim being
    // made is the one the exporter is actually responsible for.
    // 1. d4 f5 2. g3 e6 3. Bg2. Black has Bb4+ available, because b4, c3, d2 and
    // e1 are all clear once the d-pawn has moved and the bishop has vacated f1.
    const opening = recordOf(['d2d4', 'f7f5', 'g2g3', 'e7e6', 'f1g2']);

    const position = initialState();
    const history: Stack = [];
    for (const m of opening) {
      const found = legalMoves(position).find((x) => uciOf(x) === m.uci)!;
      makeMove(position, found, history);
    }

    const checking = legalMoves(position).find((m) => {
      const after = cloneState(position);
      const stack: Stack = [];
      makeMove(after, m, stack);
      return gameResult(after) === 'playing' && inCheck(after, after.turn);
    });
    expect(checking, 'the opening chosen has no checking continuation to test').toBeTruthy();

    const full = [
      ...opening,
      {
        ply: opening.length + 1,
        color: position.turn,
        san: toSAN(position, checking!),
        uci: uciOf(checking!),
        at: '2026-10-15T12:30:00.000Z',
      },
    ];

    const { text } = pgnMovetext(full);
    expect(text!.endsWith('+')).toBe(true);
    expect(text).not.toContain('#');
    // The move that was played is the one written, with nothing appended but the
    // check marker.
    expect(text).toContain(toSAN(position, checking!));
  });

  it('maps every ending onto a legal result tag', () => {
    const base = { whiteId: 1, blackId: 2 };
    expect(pgnResult({ ...base, status: 'checkmate', winnerId: 1 })).toBe('1-0');
    expect(pgnResult({ ...base, status: 'resigned', winnerId: 1 })).toBe('1-0');
    expect(pgnResult({ ...base, status: 'timeout', winnerId: 2 })).toBe('0-1');
    expect(pgnResult({ ...base, status: 'stalemate', winnerId: null })).toBe('1/2-1/2');
    expect(pgnResult({ ...base, status: 'draw', winnerId: null })).toBe('1/2-1/2');
    // An unfinished game is not a draw. "*" is what says "still going".
    expect(pgnResult({ ...base, status: 'open', winnerId: null })).toBe('*');
  });

  it('refuses to emit a file whose moves will not replay', () => {
    // A record that cannot be replayed would produce a PGN no program can load,
    // and the failure would surface months later with nobody left to explain it.
    const broken: SealedMove[] = [
      { ply: 1, color: 'w', san: 'e4', uci: '999:999:', at: '2026-10-15T12:00:00.000Z' },
    ];
    expect(toPgn({ status: 'open', winnerId: null, whiteId: 1, blackId: 2 }, broken, { white: 'A', black: 'B' })).toBeNull();
  });

  it('escapes a quote so it cannot close a tag early', () => {
    const pgn = toPgn(
      { status: 'open', winnerId: null, whiteId: 1, blackId: 2 },
      recordOf(['e2e4']),
      { white: 'Ada "Bird"', black: 'Margot' },
    );
    expect(pgn).toContain('[White "Ada \'Bird\'"]');
  });

  it('wraps movetext at 80 columns', () => {
    const long = Array.from({ length: 60 }, (_, i) => `N${'abcdefgh'[i % 8]}${i % 8 + 1}`).join(' ');
    const wrapped = wrapMovetext(long).split('\n');
    for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(80);
    expect(wrapped.length).toBeGreaterThan(1);
    // Wrapping must not lose or reorder a single token.
    expect(wrapped.join(' ').split(' ')).toEqual(long.split(' '));
  });

  it('swaps the names when the viewer is not white', () => {
    expect(namesFor({ youAre: 'w' }, 'Ada', 'Margot')).toEqual({ white: 'Ada', black: 'Margot' });
    expect(namesFor({ youAre: 'b' }, 'Ada', 'Margot')).toEqual({ white: 'Margot', black: 'Ada' });
  });

  it('names the file after the game, in a sortable way', () => {
    expect(pgnFilename('2026-10-15T12:00:00Z', 'Ada Lovelace')).toBe('penpal-2026-10-15-ada-lovelace');
    expect(pgnFilename('2026-10-15T12:00:00Z', '  ')).toBe('penpal-2026-10-15');
  });
});
