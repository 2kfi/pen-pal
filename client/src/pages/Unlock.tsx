import { useState, type FormEvent } from 'react';
import { useAuth } from '../stores/auth';
import { useVault } from '../lib/vault';

/**
 * The vault gate.
 *
 * Signing in proves *who* you are; it does not hand over your private key. That
 * key stays wrapped on the server until you supply the password here, and it is
 * held in memory only for the rest of the session.
 *
 * v0.0.2 had no equivalent: the key was never wrapped in a recoverable form, and
 * Reader.tsx simply hardcoded "(encrypted — unlock with your private key)".
 */
export default function Unlock() {
  const user = useAuth((s) => s.user);
  const { status, error, unlock, clearError } = useVault();
  const [password, setPassword] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user?.encryptedPrivateKey) return;
    clearError();
    await unlock(JSON.parse(user.encryptedPrivateKey), password);
    setPassword('');
  };

  const busy = status === 'unlocking';

  return (
    <div className="card auth-card">
      <h1>Unlock your letters</h1>
      <p className="muted">
        Signed in as <strong>{user?.friendly_name || user?.username}</strong>. Enter your password to
        decrypt your key. It is held in memory only and is gone when you close the tab.
      </p>

      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="unlock-password">Password</label>
          <input
            id="unlock-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-describedby={error ? 'unlock-error' : undefined}
            aria-invalid={error ? true : undefined}
            required
          />
        </div>

        {error && (
          <p className="field-error" id="unlock-error" role="alert">
            {error}
          </p>
        )}

        <button className="primary" type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}