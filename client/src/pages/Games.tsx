import { Suspense, lazy } from 'react';

const ChessBoard = lazy(() => import('../components/ChessBoard'));

export default function Games() {
  return (
    <div className="card">
      <h1>Play — Chess</h1>
      <p className="muted">You play white, against the computer.</p>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <button className="primary" aria-pressed="true">
          Play vs computer
        </button>
        <button disabled title="Playing with a friend is not available yet">
          Play with a friend — not available yet
        </button>
      </div>
      <Suspense fallback={<p className="muted">Loading board…</p>}>
        <ChessBoard />
      </Suspense>
    </div>
  );
}
