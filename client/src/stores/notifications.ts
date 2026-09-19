import { create } from 'zustand';
import { api } from '../lib/api';

export interface Notif {
  id: number;
  type: string;
  title: string;
  body: string | null;
  read: number;
  created_at: string;
}

interface NotifState {
  items: Notif[];
  unread: number;
  loading: boolean;
  error: string;
  fetch: (limit?: number) => Promise<void>;
  markRead: () => Promise<void>;
}

export const useNotifs = create<NotifState>((set, get) => ({
  items: [],
  unread: 0,
  loading: false,
  error: '',
  fetch: async (limit = 20) => {
    if (get().loading) return;
    set({ loading: true, error: '' });
    try {
      const items = await api<Notif[]>(`/api/notifications?limit=${limit}`);
      set({ items, unread: items.filter((n) => !n.read).length, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load updates' });
    }
  },
  markRead: async () => {
    await api('/api/notifications/read', { method: 'PUT' });
    set((s) => ({ items: s.items.map((n) => ({ ...n, read: 1 })), unread: 0 }));
  },
}));
