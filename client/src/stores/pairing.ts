import { create } from 'zustand';
import { api } from '../lib/api';

export interface PairRequest {
  id: number;
  username: string;
  pid: string;
}
export interface OutgoingRequest {
  id: number;
  target_pid: string;
  status: string;
}
export interface Partner {
  id: number;
  username: string;
  friendly_name?: string;
  pid: string;
  publicKey?: string;
  avatar_url?: string | null;
}

interface PairingState {
  incoming: PairRequest[];
  outgoing: OutgoingRequest[];
  partner: Partner | null;
  myPid: string | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  request: (targetPid: string) => Promise<void>;
  accept: (requestId: number) => Promise<void>;
  reject: (requestId: number) => Promise<void>;
  unpair: () => Promise<void>;
}

interface StatusRes {
  incoming: PairRequest[];
  outgoing: OutgoingRequest[];
  partner: Partner | null;
}

export const usePairing = create<PairingState>((set) => ({
  incoming: [],
  outgoing: [],
  partner: null,
  myPid: null,
  loading: false,
  error: '',
  refresh: async () => {
    set({ loading: true, error: '' });
    try {
      const [status, me] = await Promise.all([
        api<StatusRes>('/api/pairing/status'),
        api<{ pid: string }>('/api/me'),
      ]);
      set({ ...status, myPid: me.pid, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Pairing fetch failed' });
    }
  },
  request: async (targetPid) => {
    await api('/api/pairing/request', { method: 'POST', body: JSON.stringify({ targetPid }) });
    await usePairing.getState().refresh();
  },
  accept: async (requestId) => {
    await api('/api/pairing/accept', { method: 'POST', body: JSON.stringify({ requestId }) });
    await usePairing.getState().refresh();
  },
  reject: async (requestId) => {
    await api('/api/pairing/reject', { method: 'POST', body: JSON.stringify({ requestId }) });
    await usePairing.getState().refresh();
  },
  unpair: async () => {
    await api('/api/pairs/unpair', { method: 'DELETE' });
    set({ partner: null });
  },
}));
