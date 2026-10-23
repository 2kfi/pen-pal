import { create } from 'zustand';
import { api } from '../lib/api';

export interface PairRequest {
  id: number;
  username: string;
  friendly_name?: string | null;
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
  /** Every correspondent, newest partnership first. Pen pals, plural. */
  partners: Partner[];
  /** The pal the letter/mock/ritual surfaces are pointed at right now. */
  partner: Partner | null;
  activePalId: number | null;
  myPid: string | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  setActivePal: (id: number) => void;
  request: (targetPid: string) => Promise<void>;
  accept: (requestId: number) => Promise<void>;
  reject: (requestId: number) => Promise<void>;
  unpair: (partnerId?: number) => Promise<void>;
}

interface StatusRes {
  incoming: PairRequest[];
  outgoing: OutgoingRequest[];
  partners: Partner[];
  partner: Partner | null;
}

const ACTIVE_KEY = 'penpal_active_pal';

function readActivePal(): number | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(ACTIVE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function writeActivePal(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, String(id));
  } catch {
    // The active pal is a UI preference; a blocked store must not take the pairing flow with it.
  }
}

export const usePairing = create<PairingState>((set) => ({
  incoming: [],
  outgoing: [],
  partners: [],
  partner: null,
  activePalId: null,
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
      const partners = [...status.partners];
      // The pal you last wrote to is the pal you mean; a stored id that names
      // nobody current (fresh device, that pal since unpaired) resolves to the
      // newest partnership instead.
      const wanted = readActivePal();
      const fallback = status.partner?.id ?? partners[0]?.id ?? null;
      const activeId =
        wanted !== null && partners.some((p) => p.id === wanted) ? wanted : fallback;
      const partner = partners.find((p) => p.id === activeId) ?? null;
      if (activeId !== wanted) writeActivePal(activeId);
      set({ ...status, partners, partner, activePalId: activeId, myPid: me.pid, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Pairing fetch failed' });
    }
  },
  setActivePal: (id) => {
    const partner = usePairing.getState().partners.find((p) => p.id === id) ?? null;
    writeActivePal(partner ? id : null);
    set({ partner, activePalId: partner ? id : null });
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
  unpair: async (partnerId) => {
    await api('/api/pairs/unpair', { method: 'DELETE', body: JSON.stringify({ partnerId }) });
    if ((partnerId ?? null) === usePairing.getState().activePalId) writeActivePal(null);
    await usePairing.getState().refresh();
  },
}));
