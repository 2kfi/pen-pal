import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth, type UserProfile } from '../stores/auth';
import { useVault } from '../lib/vault';
import Field from '../components/Field';

interface LoginResponse {
  token: string;
  user: UserProfile;
}

/**
 * v0.0.2's login posted to `/api/auth/login` (no such route) using a `username`
 * field (the server expects `email`), so authentication was 100% broken — there
 * was no way into the app at all.
 */
export default function Login() {
  const nav = useNavigate();
  const login = useAuth((s) => s.login);
  const unlock = useVault((s) => s.unlock);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api<LoginResponse>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      login(res.token, res.user);

      // Unlock with the same password. If this fails the user still gets in, but
      // lands on the unlock gate rather than a wall of undecryptable letters.
      if (res.user.encryptedPrivateKey) {
        await unlock(JSON.parse(res.user.encryptedPrivateKey), password);
      }
      nav('/letters', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="card auth-card">
      <h1>Sign in</h1>
      <form onSubmit={submit} noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          maxLength={254}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="muted">
        No account yet? <Link to="/signup">Start a correspondence</Link>
      </p>
    </div>
  );
}