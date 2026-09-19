import { useMemo, useState } from 'react';
import { GLYPH, applyMove, bestMove, inCheck, initialBoard, legalMoves } from '../lib/chess';
import type { Board } from '../lib/chess';

function sqName(i: number): string {
  return `${'abcdefgh'[i % 8]}${8 - Math.floor(i / 8)}`;
}

// You play white; the computer plays black.
export default function ChessBoard() {
  const [board, setBoard] = useState<Board>(initialBoard);
  const [sel, setSel] = useState<number | null>(null);
  const [over, setOver] = useState('');
  const whiteMoves = useMemo(() => legalMoves(board, 'w'), [board]);
  const targets = useMemo(() => new Set(whiteMoves.filter((m) => m.from === sel).map((m) => m.to)), [whiteMoves, sel]);

  const click = (i: number) => {
    if (over) return;
    const p = board[i];
    if (sel === null) {
      if (p && p.c === 'w') setSel(i);
      return;
    }
    const m = whiteMoves.find((m) => m.from === sel && m.to === i);
    setSel(null);
    if (!m) {
      if (p && p.c === 'w') setSel(i);
      return;
    }
    let nb = applyMove(board, m);
    const reply = bestMove(nb, 'b');
    if (reply) nb = applyMove(nb, reply);
    setBoard(nb);
    const mine = legalMoves(nb, 'w');
    if (!mine.length) {
      setOver(inCheck(nb, 'w') ? 'Checkmate — the computer wins. Start a new game?' : 'Draw — no moves left. Start a new game?');
    } else if (inCheck(nb, 'w')) {
      setOver('Check — your king is under attack.');
    } else {
      setOver('');
    }
  };

  const reset = () => {
    setBoard(initialBoard());
    setSel(null);
    setOver('');
  };

  return (
    <div>
      <div className="chess-board" role="grid" aria-label="Chess board">
        {board.map((p, i) => {
          const light = (Math.floor(i / 8) + (i % 8)) % 2 === 1;
          return (
            <button
              key={i}
              role="gridcell"
              className={`chess-sq${light ? ' light' : ''}${sel === i ? ' sel' : ''}${targets.has(i) ? ' tgt' : ''}`}
              onClick={() => click(i)}
              aria-label={`${sqName(i)}${p ? ` ${p.c === 'w' ? 'white' : 'black'} ${p.t}` : ''}`}
            >
              {p ? GLYPH[p.c][p.t] : ''}
            </button>
          );
        })}
      </div>
      {over && <p className="muted">{over}</p>}
      <button onClick={reset} style={{ marginTop: '0.5rem' }}>
        New game
      </button>
    </div>
  );
}
