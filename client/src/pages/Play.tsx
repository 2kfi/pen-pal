import { ChessBoard } from '../components/ChessBoard';

/**
 * Play.
 *
 * v0.0.2 rendered a disabled button reading "Play with a friend — not available yet",
 * next to a solo board whose engine could not castle, could not en passant, forced
 * promotion to queen, and ran a depth-2 material-only search on the main thread.
 *
 * Playing *with your pen pal* is a plan step, not a lie we tell the user about.
 * Until it ships the surface says so plainly instead of advertising a dead control.
 */
export default function Play() {
  return (
    <div className="play">
      <h1>Play</h1>
      <p className="muted">
        A game of chess against your pen pal. Moves are sealed like letters, so neither of you
        can peek at a position the other has not sent.
      </p>

      <ChessBoard />
    </div>
  );
}