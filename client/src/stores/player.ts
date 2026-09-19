import { create } from 'zustand';

export interface Track {
  id: string;
  name: string;
  streamUrl: string;
}

interface PlayerState {
  track: Track | null;
  playing: boolean;
  play: (t: Track) => void;
  toggle: () => void;
  close: () => void;
}

export const usePlayer = create<PlayerState>((set) => ({
  track: null,
  playing: false,
  play: (t) => set({ track: t, playing: true }),
  toggle: () => set((s) => (s.track ? { playing: !s.playing } : s)),
  close: () => set({ track: null, playing: false }),
}));
