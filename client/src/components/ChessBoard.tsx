import { useMemo, useState } from 'react';
import {
  GLYPH,
  applyMove,
  bestMove,
  inCheck,
  initialBoard,
  legalMoves,
  type Board,
  type Color,
  type Move,
} from '../lib/chess';

/**
 * Chessboard.
 *
 * Note for the record: the engine behind this (lib/chess.ts) is still the v0.0.2
 * one — no castling, no en passant, forced queen promotion, material-only eval,
 * synchronous on the main thread. Rebuilding it against perft-verified rules is
 * plan step 24. It renders and plays; it is not yet correct.
 *
 * Accessibility: every square is a real <button> in a grid, reachable by
 * keyboard, with an accessible name of its algebraic coordinate.
 */

const FILES = 'abcdefgh';

function squareName(index: number): string {
  return `${FILES[index % 8]}${8 - Math.floor(index / 8)}`;
}

export function ChessBoard() {
  const [board, setBoard] = useState<Board>(initialBoard);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState('White to move.');

  const whiteMoves = useMemo(() => legalMoves(board, 'w'), [board]);
  const targets = useMemo(
    () => new Set(whiteMoves.filter((m: Move) => m.from === selected).map((m: Move) => m.to)),
    [whiteMoves, selected],
  );

  const play = (index: number) => {
    const piece = board[index];

    if (selected === null) {
      if (piece?.c === 'w') setSelected(index);
      return;
    }

    const move = whiteMoves.find((m: Move) => m.from === selected && m.to === index);
    setSelected(null);

    if (!move) {
      // Clicking another of your own pieces re-selects rather than doing nothing.
      if (piece?.c === 'w') setSelected(index);
      return;
    }

    let next: Board = applyMove(board, move);
    const reply = bestMove(next, 'b' as Color);
    if (reply) next = applyMove(next, reply);

    setBoard(next);

    const options = legalMoves(next, 'w');
    if (options.length === 0) {
      setStatus(inCheck(next, 'w') ? 'Checkmate. The computer wins.' : 'Draw — no legal moves.');
    } else if (inCheck(next, 'w')) {
      setStatus('Check. Your king is under attack.');
    } else {
      setStatus('White to move.');
    }
  };

  const reset = () => {
    setBoard(initialBoard());
    setSelected(null);
    setStatus('White to move.');
  };

  return (
    <div>
      <div className="board" role="grid" aria-label="Chess board">
        {board.map((piece, index) => {
          const light = (Math.floor(index / 8) + index % 8) % 2 === 1;
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

      {/* Announced to screen readers on every change. */}
      <p className="chess-status" role="status" aria-live="polite">
        {status}
      </p>

      <button type="button" onClick={reset}>
        New game
      </button>
    </div>
  );
}

export default ChessBoard;