import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLetters } from '../stores/letters';
import { EnvelopeIcon, PenIcon } from '../components/Icons';

const WINDOW = 50;

export default function Letters() {
  const { items, hasMore, loading, error, fetchMore } = useLetters();
  const [rendered, setRendered] = useState(WINDOW);

  useEffect(() => {
    if (items.length === 0) void fetchMore();
  }, [items.length, fetchMore]);

  const visible = items.length > WINDOW ? items.slice(0, rendered) : items;
  const hidden = items.length - visible.length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <EnvelopeIcon /> Letters
        </h1>
        <Link to="/letters/new" style={{ marginLeft: 'auto' }}>
          <button className="primary" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <PenIcon size={16} /> Compose
          </button>
        </Link>
      </div>

      {error && <p className="muted">{error}</p>}

      <div className="stream">
        <svg className="spine" width="24" height="100%" preserveAspectRatio="none" aria-hidden>
          <path d="M12 0 C 4 120, 20 240, 12 360 C 4 480, 20 600, 12 800 L 12 2000" />
        </svg>
        {visible.map((l) => (
          <Link key={l.id} to={`/letters/${l.id}`} className="letter-card">
            <span className="letter-dot" aria-hidden />
            <span className="muted">#{l.id} · {l.sent_at}</span>
            <p>{previewOf(l.encrypted_content)}</p>
          </Link>
        ))}
        {items.length === 0 && !loading && <p className="muted">No letters yet.</p>}
      </div>

      {hidden > 0 && (
        <button onClick={() => setRendered((r) => r + WINDOW)}>Show more ({hidden} remaining)</button>
      )}
      {hidden <= 0 && hasMore && (
        <button onClick={() => void fetchMore()} disabled={loading}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
}

// ponytail: encrypted blobs aren't readable; show a short safe prefix, never HTML
function previewOf(content: string): string {
  try {
    const o = JSON.parse(content) as { content?: string };
    return typeof o.content === 'string' ? '(encrypted letter)' : content.slice(0, 120);
  } catch {
    return content.slice(0, 120);
  }
}
