import { create } from 'zustand';
import { api } from '../lib/api';

export interface Library {
  Id: string;
  Name: string;
}

export interface MediaItem {
  Id: string;
  Name: string;
  Type: string;
  imageUrl: string;
  streamUrl: string | null;
}

interface MediaState {
  configured: boolean | null;
  libraries: Library[];
  items: MediaItem[];
  activeLibrary: string | null;
  loading: boolean;
  error: string;
  init: () => Promise<void>;
  select: (id: string) => Promise<void>;
}

export const useMedia = create<MediaState>((set, get) => ({
  configured: null,
  libraries: [],
  items: [],
  activeLibrary: null,
  loading: false,
  error: '',
  init: async () => {
    const { loading } = get();
    if (loading) return;
    set({ loading: true, error: '' });
    try {
      const status = await api<{ configured: boolean }>('/api/jellyfin/status');
      if (!status.configured) {
        set({ configured: false, loading: false });
        return;
      }
      const libraries = await api<Library[]>('/api/jellyfin/libraries');
      set({ configured: true, libraries });
      const first = libraries[0]?.Id ?? null;
      set({ activeLibrary: first, loading: false });
      if (first) await get().select(first);
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load the library' });
    }
  },
  select: async (id) => {
    set({ activeLibrary: id, loading: true, error: '' });
    try {
      const items = await api<MediaItem[]>(`/api/jellyfin/items?libraryId=${encodeURIComponent(id)}`);
      set({ items, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load items' });
    }
  },
}));
