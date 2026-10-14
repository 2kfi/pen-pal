/**
 * Session state.
 *
 * What is held where:
 *   - access token  -> a module-scoped variable. MEMORY ONLY. Never written to
 *                      localStorage, sessionStorage, IndexedDB or any cookie. An
 *                      XSS can read a variable; it cannot exfiltrate storage it
 *                      never wrote.
 *   - refresh token -> an httpOnly cookie the JavaScript cannot read at all.
 *   - public profile-> localStorage. Not sensitive, and it avoids a round-trip
 *                      on first paint.
 *
 * A full page reload therefore loses the access token by design. That is not a
 * bug: the client silently refreshes from the cookie on boot, so the user sees
 * no difference and the token still never rests in storage.
 *
 * v0.0.2 kept the access token in localStorage, where any XSS could take it and
 * replay it for the full 7 days.
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
  encryptedPrivateKey: string | null;
}

interface AuthState {
  /** True once a refresh has confirmed there is a live session. */
  authenticated: boolean;
  /** True during the initial silent-refresh, so the UI can show a splash. */
  restoring: boolean;
  user: UserProfile | null;
  signIn: (token: string, user: UserProfile) => void;
  signOut: () => void;
  /** Called once at boot: trades the httpOnly cookie for a fresh access token. */
  restore: () => Promise<boolean>;
  refreshProfile: () => Promise<void>;
}

const PROFILE_KEY = 'pp_profile';

/**
 * Storage access guarded. Reading localStorage at module scope throws in Node,
 * which took down any test file that merely imported this module; it also throws
 * in Safari private mode when cookies are blocked.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Touch it: Safari private mode throws on access, not on the typeof check.
    localStorage.getItem(PROFILE_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

function readStoredProfile(): UserProfile | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) return parsed as UserProfile;
    return null;
  } catch {
    store.removeItem(PROFILE_KEY);
    return null;
  }
}

/**
 * The access token lives here and nowhere else. A closure rather than React
 * state so there is exactly one copy to audit.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

function setAccessToken(token: string | null): void {
  accessToken = token;
}

export const useAuth = create<AuthState>((set) => ({
  authenticated: false,
  restoring: true,
  user: readStoredProfile(),

  signIn: (token, user) => {
    setAccessToken(token);
    storage()?.setItem(PROFILE_KEY, JSON.stringify(user));
    set({ authenticated: true, restoring: false, user });
  },

  signOut: () => {
    setAccessToken(null);
    storage()?.removeItem(PROFILE_KEY);
    // Dropping the token without dropping the key would leave a decrypted
    // private key resident after sign-out.
    useVault.getState().lock();
    set({ authenticated: false, restoring: false, user: null });
  },

  /**
   * Exchange the httpOnly refresh cookie for a fresh access token.
   * Returns false when there is no live session, which is the normal
   * signed-out path — not an error.
   */
  restore: async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'penpal' },
      });
      if (!res.ok) {
        setAccessToken(null);
        set({ authenticated: false, restoring: false });
        return false;
      }
      const data = (await res.json()) as { token: string };
      setAccessToken(data.token);
      set({ authenticated: true, restoring: false });
      return true;
    } catch {
      setAccessToken(null);
      set({ authenticated: false, restoring: false });
      return false;
    }
  },

  refreshProfile: async () => {
    const { api } = await import('../lib/api');
    const user = await api<UserProfile>('/api/me');
    storage()?.setItem(PROFILE_KEY, JSON.stringify(user));
    set({ user });
  },
}));