import { useMemo, useState } from 'react';
import {
  GLYPH,
  cloneState,
  file,
  gameResult,
  initialState,
  legalMoves,
  makeMove,
  rank,
  toSAN,
  type GameState,
  type Move,
} from '../lib/chessEngine';

/**
 * Chessboard.
 *
 * Backed by lib/chessEngine, whose move generation is verified by perft against
 * published constants. It handles castling, en passant, under-promotion, the
 * fifty-move rule and insufficient material — none of which the v0.0.2 engine
 * supported, and all of which it silently got wrong.
 *
 * Search is not yet implemented (plan step 25: a Web Worker with iterative
 * deepening and a transposition table). Until then this is a two-player board;
 * claiming "play the computer" without a search would be a lie in the UI.
 *
 * Accessibility: every square is a real <button> in a grid, keyboard reachable,
 * named by its algebraic coordinate. Drag-and-drop is deliberately not the only
 * way to move a piece — WCAG 2.2 §2.5.7 Dragging Movements requires a
 * single-pointer alternative, and click-to-select / click-to-move is that path.
 */

const FILES = 'abcdefgh';

function squareName(index: number): string {
  return `${FILES[file(index)]}${8 - rank(index)}`;
}

// The engine's undo stack type is not exported; alias it so this file does not
// have to restate the shape.
type Stack = Parameters<typeof makeMove>[2];

export function ChessBoard() {
  const [game, setGame] = useState<GameState>(initialState);
  const [selected, setSelected] = useState<number | null>(null);
  const [sideToMove, setSideToMove] = useState<'w' | 'b'>('w');
  const [played, setPlayed] = useState<Move[]>([]);
  const [status, setStatus] = useState('White to move.');

  // The engine mutates while generating, so it works on a throwaway copy.
  const moves = useMemo(() => legalMoves(cloneState(game)), [game]);
  const targets = useMemo(
    () => new Set(moves.filter((m) => m.from === selected).map((m) => m.to)),
    [moves, selected],
  );
  const moveList = useMemo(() => {
    // SAN is computed against the position each move was played from, so the
    // list is rebuilt by replaying rather than formatting against the final board.
    const replay = initialState();
    const stack: Stack = [];
    const out: string[] = [];
    for (const m of played) {
      out.push(toSAN(replay, m));
      makeMove(replay, m, stack);
    }
    return out;
  }, [played]);

  const play = (index: number) => {
    const piece = game.board[index];

    if (selected === null) {
      if (piece?.c === sideToMove) setSelected(index);
      return;
    }

    const move = moves.find((m) => m.from === selected && m.to === index);
    if (!move) {
      if (piece?.c === sideToMove) setSelected(index);
      else setSelected(null);
      return;
    }

    const san = toSAN(game, move);
    const next = cloneState(game);
    const stack: Stack = [];
    makeMove(next, move, stack);

    setGame(next);
    setPlayed((h) => [...h, move]);
    setSelected(null);
    void san;

    const result = gameResult(next);
    if (result === 'checkmate') {
      setStatus(sideToMove === 'w' ? 'Checkmate — white wins.' : 'Checkmate — black wins.');
      return;
    }
    if (result === 'stalemate') {
      setStatus('Stalemate — draw.');
      return;
    }
    if (result === 'fifty-move') {
      setStatus('Draw by the fifty-move rule.');
      return;
    }
    if (result === 'insufficient-material') {
      setStatus('Draw — insufficient material.');
      return;
    }

    const mover = sideToMove;
    setSideToMove(mover === 'w' ? 'b' : 'w');
    setStatus(
      mover === 'w' ? 'Black to move.' : 'White to move.',
    );
  };

  const reset = () => {
    setGame(initialState());
    setSelected(null);
    setSideToMove('w');
    setPlayed([]);
    setStatus('White to move.');
  };

  /**
   * Take back the last move. The engine's state is rebuilt by replaying the
   * remaining moves from the start position rather than by hand-editing the
   * board, because castling rights, the en-passant square and the halfmove clock
   * all have to unwind together and it is easy to get subtly wrong.
   */
  const undo = () => {
    if (played.length === 0) return;
    const remaining = played.slice(0, -1);
    const replay = initialState();
    const stack: Stack = [];
    for (const m of remaining) makeMove(replay, m, stack);

    setGame(replay);
    setPlayed(remaining);
    setSelected(null);
    setSideToMove(replay.turn);
    setStatus(`${replay.turn === 'w' ? 'White' : 'Black'} to move.`);
  };

  return (
    <div>
      <div className="board" role="grid" aria-label="Chess board">
        {game.board.map((piece, index) => {
          const light = (rank(index) + file(index)) % 2 === 1;
          const classes = ['square'];
          if (light) classes.push('light');
          if (selected === index) classes.push('selected');
          if (targets.has(index)) classes.push('target');

          return (
            <button
              key={index}
              type="button"
              role="gridcell"
              className={classes.join(' ')}
              onClick={() => play(index)}
              aria-label={`${squareName(index)}${piece ? `, ${piece.c === 'w' ? 'white' : 'black'} ${piece.t}` : ', empty'}`}
              aria-pressed={selected === index}
            >
              <span aria-hidden>{piece ? GLYPH[piece.c][piece.t] : ''}</span>
            </button>
          );
        })}
      </div>

      {/* Announced on every change so a screen-reader user follows the game. */}
      <p className="chess-status" role="status" aria-live="polite">
        {status}
      </p>

      {moveList.length > 0 && (
        <p className="chess-status" aria-label="Move list">
          {moveList.join(' ')}
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" onClick={reset}>
          New game
        </button>
        <button type="button" onClick={undo} disabled={played.length === 0}>
          Take back
        </button>
      </div>
    </div>
  );
}

export default ChessBoard;