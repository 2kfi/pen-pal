import { create } from 'zustand';
import { api } from '../lib/api';

export interface Letter {
  id: number;
  sender_id: number;
  recipient_id: number;
  encrypted_content: string;
  encrypted_metadata: string | null;
  photo_paths: string | null;
  sent_at: string;
  delivered_at: string | null;
}

interface LettersState {
  items: Letter[];
  cursor: number | null;
  hasMore: boolean;
  loading: boolean;
  error: string;
  fetchMore: (limit?: number) => Promise<void>;
  reset: () => void;
  byId: (id: number) => Letter | undefined;
}

export const useLetters = create<LettersState>((set, get) => ({
  items: [],
  cursor: null,
  hasMore: true,
  loading: false,
  error: '',
  fetchMore: async (limit = 25) => {
    const { loading, hasMore, cursor } = get();
    if (loading || !hasMore) return;
    set({ loading: true, error: '' });
    try {
      const q = cursor === null ? `?limit=${limit}` : `?limit=${limit}&cursor=${cursor}`;
      const batch = await api<Letter[]>(`/api/letters/sync${q}`);
      set((s) => ({
        items: [...s.items, ...batch],
        cursor: batch.length ? batch[batch.length - 1].id : s.cursor,
        hasMore: batch.length === limit,
        loading: false,
      }));
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load letters' });
    }
  },
  reset: () => set({ items: [], cursor: null, hasMore: true, error: '' }),
  byId: (id) => get().items.find((l) => l.id === id),
}));
