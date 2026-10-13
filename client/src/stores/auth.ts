/**
 * Session state.
 *
 * What is persisted: the JWT and the *public* profile only.
 * What is never persisted: the private key (see lib/vault.ts).
 */

import { create } from 'zustand';
import { useVault } from '../lib/vault';

export interface UserProfile {
  id: number;
  username: string;
  email: string;
  pid: string;
  friendly_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  publicKey: string | null;
  /** Server-side AES-GCM wrapper around the private key. Unusable without the password. */
  encryptedPrivateKey: string | null;
}

interface AuthState {
  token: string | null;
  user: UserProfile | null;
  login: (token: string, user: UserProfile) => void;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

const TOKEN_KEY = 'pp_token';
const USER_KEY = 'pp_user';

function readStoredUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // v0.0.2 did a bare JSON.parse at module scope with no guard, so a corrupted
    // localStorage entry hard-crashed the bundle before React ever mounted.
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) return parsed as UserProfile;
    return null;
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem(TOKEN_KEY),
  user: readStoredUser(),

  login: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ token, user });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // Dropping the token without dropping the key would leave a decrypted private
    // key resident after logout.
    useVault.getState().lock();
    set({ token: null, user: null });
  },

  refreshProfile: async () => {
    const { api } = await import('../lib/api');
    const user = await api<UserProfile>('/api/me');
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    set({ user });
  },
}));

/** True once both a token and a usable profile are present. */
export function isSignedIn(): boolean {
  const { token, user } = useAuth.getState();
  return Boolean(token && user?.id);
}