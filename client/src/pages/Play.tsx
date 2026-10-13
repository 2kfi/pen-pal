import { ChessBoard } from '../components/ChessBoard';

/**
 * Play.
 *
 * The board is backed by a perft-verified rules engine, so castling, en passant,
 * under-promotion and draw detection all work. There is no opponent engine yet —
 * v0.0.2 shipped a depth-2 material-only search that ran on the main thread and
 * froze the UI. Search in a Web Worker is plan step 25.
 *
 * Until then this is a two-player board, and the page says so rather than
 * advertising a computer opponent that does not exist.
 */
export default function Play() {
  return (
    <div className="play">
      <h1>Play</h1>
      <p className="muted">
        Chess for two. Take back a move if you misclick. Playing against your pen pal over the
        wire is next — moves will be sealed like letters so neither of you can peek at a position
        the other has not sent.
      </p>

      <ChessBoard />
    </div>
  );
}