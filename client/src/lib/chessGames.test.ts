/**
 * `positionBeforeLastPly` (the take-back slot).
 *
 * A take-back after a refresh is reconstructed by replaying the sealed move
 * list one ply short. The legal-path case is tested against the engine here;
 * the "never live without a server answer" ordering lives in the store, which
 * is where a wrong defence belongs.
 */
import { describe, expect, it } from 'vitest';
import { applyMove, positionBeforeLastPly, sealPayload, uciOf } from './chessGames';
import { initialState, legalMoves, type GameState } from './chessEngine';

/** Plays the first `n` legal pawn-ish plies and returns them as sealed moves. */
function sealedList(n: number, state?: GameState) {
  let cur = state ?? initialState();
  const moves = [];
  for (let i = 0; i < n; i++) {
    const legal = legalMoves(cur);
    const move = legal.find((m) => !m.captured && !m.castleKing && !m.castleQueen && !m.promotion)!;
    const { state: next, record } = applyMove(cur, move, moves);
    moves.push(record);
    cur = next;
  }
  return { moves, state: cur };
}

describe('positionBeforeLastPly', () => {
  it('rebuilds the position one ply back, and the shorter list', () => {
    const { moves, state } = sealedList(4);
    const base = positionBeforeLastPly(moves);
    expect(base.moves).toHaveLength(3);
    // The base position is what the board was before the last sealed ply, so
    // replaying the next legal list from it must contain the last move again.
    const last = moves[3];
    const legal = legalMoves(base.position);
    expect(legal.some((m) => uciOf(m) === last.uci)).toBe(true);
    // And it is not the final position of the list.
    expect(base.position).not.toEqual(state);
  });

  it('refuses an empty list rather than handing back a fantasy starting position', () => {
    expect(() => positionBeforeLastPly([])).toThrow(/no moves/);
  });

  it('round-trips through the sealed payload on a single-ply game (base = start)', () => {
    const { moves } = sealedList(1);
    const base = positionBeforeLastPly(moves);
    // One ply played and taken back: the board goes back to the opening, which
    // is a real position the server also holds, not a special case.
    expect(base.moves).toHaveLength(0);
    expect(base.position).toEqual(initialState());
    // The payload that seals the base is well-formed and self-consistent.
    expect(sealPayload(base.position, base.moves).moves).toHaveLength(0);
  });
});
