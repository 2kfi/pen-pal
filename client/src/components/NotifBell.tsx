import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useNotifs } from '../stores/notifications';

// Bell + panel. Polls on route enter only (no WebSocket, no interval).
export default function NotifBell() {
  const { items, unread, loading, error, fetch, markRead } = useNotifs();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    void fetch(20);
  }, [pathname, fetch]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open ]);

  return (
    <div className="notif-wrap">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Updates${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}>
        Bell{unread > 0 ? ` (${unread})` : ''}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Updates">
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <strong>Updates</strong>
            <button
              ref={closeRef}
              onClick={() => setOpen(false)}
              aria-label="Close updates"
              style={{ marginLeft: 'auto' }}
            >
              Close
            </button>
          </div>
          <button
            disabled={unread === 0}
            onClick={() => void markRead().catch(() => {})}
            aria-label="Mark all as read"
          >
            Mark all read
          </button>
          {loading && <p className="muted">Loading…</p>}
          {error && <p className="muted">{error}</p>}
          {!loading && !error && items.length === 0 && <p className="muted">Nothing new yet.</p>}
          {!loading &&
            !error &&
            items.map((n) => (
              <div key={n.id} className="card" style={{ marginTop: '0.5rem' }}>
                <p>
                  <strong>{n.title}</strong>
                </p>
                {n.body && <p className="muted">{n.body}</p>}
                <p className="muted">{n.created_at}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
