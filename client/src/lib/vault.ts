/**
 * The vault holds the user's decrypted private key for the duration of a session.
 *
 * Hard rules:
 *   - The private key lives in a JS closure and nowhere else. It is never written
 *     to localStorage, sessionStorage, IndexedDB, or any store that persists.
 *   - Reloading the page or locking the vault discards it. Unlocking again costs
 *     a 600k-iteration PBKDF2, which is deliberate.
 *   - CryptoKey is non-serialisable, so Zustand's persist middleware could not
 *     serialise it even if we asked it to. That is a safety net, not a plan.
 */

import { create } from 'zustand';
import {
  WrongPasswordError,
  deriveWrappingKey,
  importPrivateKey,
  unwrapPrivateKey,
  type WrappedPrivateKey,
} from './crypto';

export type VaultStatus = 'locked' | 'unlocking' | 'unlocked';

interface VaultState {
  status: VaultStatus;
  /** In-memory only. Never serialised. */
  privateKey: CryptoKey | null;
  error: string;
  unlock: (wrapped: WrappedPrivateKey, password: string) => Promise<void>;
  lock: () => void;
  clearError: () => void;
}

/**
 * Intentionally a module-level variable rather than React state.
 * A second copy of a private key living in a component's render state is a
 * liability; one closure reference is auditable.
 */
let sessionKey: CryptoKey | null = null;

export const useVault = create<VaultState>((set) => ({
  status: 'locked',
  privateKey: null,
  error: '',

  unlock: async (wrapped, password) => {
    set({ status: 'unlocking', error: '' });
    try {
      const jwk = await unwrapPrivateKey(wrapped, password);
      const key = await importPrivateKey(jwk);
      sessionKey = key;
      set({ status: 'unlocked', privateKey: key, error: '' });
    } catch (err) {
      sessionKey = null;
      const message =
        err instanceof WrongPasswordError
          ? 'That password does not unlock this key.'
          : err instanceof Error
            ? err.message
            : 'Could not unlock.';
      set({ status: 'locked', privateKey: null, error: message });
    }
  },

  lock: () => {
    sessionKey = null;
    set({ status: 'locked', privateKey: null, error: '' });
  },

  clearError: () => set({ error: '' }),
}));

/** Imperative accessor for code paths that are not React components (API helpers). */
export function activeKey(): CryptoKey | null {
  return sessionKey;
}

/**
 * Exposed for the PBKDF2 cost benchmark in the signup/unlock screens.
 * Kept out of the bundle's hot path — importing `deriveWrappingKey` here just to
 * re-export it would pull the whole crypto module into any consumer.
 */
export { deriveWrappingKey };