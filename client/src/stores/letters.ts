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
  /** True once a fetch has completed at least once — distinct from `loading`. */
  loaded: boolean;
  hasMore: boolean;
  loading: boolean;
  error: string;
  fetchMore: (limit?: number) => Promise<void>;
  reset: () => void;
  byId: (id: number) => Letter | undefined;
}

const PAGE = 25;

export const useLetters = create<LettersState>((set, get) => ({
  items: [],
  cursor: null,
  loaded: false,
  hasMore: true,
  loading: false,
  error: '',

  fetchMore: async (limit = PAGE) => {
    const { loading, hasMore, cursor, loaded } = get();
    if (loading || (loaded && !hasMore)) return;

    set({ loading: true, error: '' });
    try {
      const query = new URLSearchParams({ limit: String(limit) });
      // The server pages forward from a monotonic cursor; sending the last id we
      // hold is what makes "Load more" return *older* mail rather than the same page.
      if (cursor !== null) query.set('cursor', String(cursor));

      const batch = await api<Letter[]>(`/api/letters/sync?${query.toString()}`);
      const lastId = batch.length ? batch[batch.length - 1].id : cursor;

      set((s) => ({
        items: [...s.items, ...batch],
        cursor: lastId,
        hasMore: batch.length === limit,
        loading: false,
        loaded: true,
      }));
    } catch (err) {
      set({
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : 'Could not reach the archive.',
      });
    }
  },

  reset: () => set({ items: [], cursor: null, loaded: false, hasMore: true, error: '' }),
  byId: (id) => get().items.find((l) => l.id === id),
}));

/** Newest first. The server returns ascending, which reads wrong in an archive. */
export function sortNewestFirst(items: Letter[]): Letter[] {
  return [...items].sort((a, b) => b.id - a.id);
}