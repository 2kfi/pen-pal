import { useEffect, useRef } from 'react';
import { usePlayer } from '../stores/player';

// Persistent mini-player: one <audio> element, play/pause + close, fade-only CSS.
export default function MiniPlayer() {
  const { track, playing, toggle, close } = usePlayer();
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (playing) void a.play().catch(() => {});
    else a.pause();
  }, [playing, track]);

  if (!track) return null;

  return (
    <div className="mini-player" key={track.id} role="region" aria-label="Music player">
      <audio ref={ref} src={track.streamUrl} onEnded={close} />
      <span className="mini-title">{track.name}</span>
      <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button onClick={close} aria-label="Close player">
        Close
      </button>
    </div>
  );
}
