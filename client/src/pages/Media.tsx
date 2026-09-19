import { useEffect } from 'react';
import { useMedia } from '../stores/media';
import { usePlayer } from '../stores/player';

export default function Media() {
  const { configured, libraries, items, activeLibrary, loading, error, init, select } = useMedia();
  const play = usePlayer((s) => s.play);

  useEffect(() => {
    void init();
  }, [init]);

  if (configured === null && loading) {
    return (
      <div className="card">
        <h1>Watch</h1>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <h1>Watch</h1>
        <p className="muted">{error}</p>
        <button onClick={() => void init()}>Try again</button>
      </div>
    );
  }

  if (configured === false) {
    return (
      <div className="card">
        <h1>Watch</h1>
        <p>Nothing to watch yet.</p>
        <p className="muted">The family library is not connected. Ask the person who set up this server to connect it, then come back here.</p>
        <a href="https://jellyfin.org/docs/">How to set up your library</a>
      </div>
    );
  }

  return (
    <div>
      <h1>Watch</h1>
      {loading && <p className="muted">Loading…</p>}
      <div className="lib-grid" role="tablist" aria-label="Libraries">
        {libraries.map((l) => (
          <button
            key={l.Id}
            role="tab"
            aria-selected={l.Id === activeLibrary}
            aria-pressed={l.Id === activeLibrary}
            onClick={() => void select(l.Id)}
          >
            {l.Name}
          </button>
        ))}
      </div>
      {libraries.length === 0 && !loading && <p className="muted">No shelves yet.</p>}
      <div className="media-grid">
        {items.map((it) => (
          <div key={it.Id} className="card media-card">
            {it.imageUrl && <img src={it.imageUrl} alt={it.Name} loading="lazy" />}
            <p>{it.Name}</p>
            <p className="muted">{it.Type}</p>
            {it.Type === 'Audio' && it.streamUrl && (
              <button onClick={() => play({ id: it.Id, name: it.Name, streamUrl: it.streamUrl! })} aria-label={`Play ${it.Name}`}>
                Play
              </button>
            )}
          </div>
        ))}
      </div>
      {items.length === 0 && !loading && libraries.length > 0 && <p className="muted">This shelf is empty.</p>}
    </div>
  );
}
