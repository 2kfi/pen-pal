import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { SecureContextError, exportKey, generateKeyPair, isCryptoAvailable, wrapPrivateKey } from '../lib/crypto';
import { useAuth, type UserProfile } from '../stores/auth';
import { useVault } from '../lib/vault';
import Field from '../components/Field';

interface SignupResponse {
  token: string;
  user: UserProfile;
}

/**
 * Signup generates the user's RSA keypair *in the browser* before the account is
 * ever created. The private key is wrapped with their password and only the
 * wrapped form is sent. If this page cannot run WebCrypto it refuses to continue —
 * creating an account whose letters cannot later be read would be worse than
 * refusing outright.
 */
export default function Signup() {
  const nav = useNavigate();
  const login = useAuth((s) => s.login);
  const unlock = useVault((s) => s.unlock);

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const cryptoOk = isCryptoAvailable();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Use a password of at least 8 characters.');
      document.getElementById('password')?.focus();
      return;
    }
    if (password !== confirm) {
      setError('Those passwords do not match.');
      document.getElementById('confirm')?.focus();
      return;
    }

    setBusy(true);
    try {
      // Key generation happens client-side. Nothing secret is transmitted except
      // the password-wrapped private key, which is useless without the password.
      const pair = await generateKeyPair();
      const privateJwk = await exportKey(pair.privateKey);
      const publicJwk = await exportKey(pair.publicKey);
      const wrapped = await wrapPrivateKey(privateJwk, password);

      const res = await api<SignupResponse>('/api/signup', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          email: email.trim(),
          password,
          publicKey: JSON.stringify(publicJwk),
          encryptedPrivateKey: JSON.stringify(wrapped),
        }),
      });

      login(res.token, res.user);

      // Unlock straight away so the user lands in the app already able to read mail.
      // A failed unlock is recoverable — the wrapped key is still on the server.
      await unlock(JSON.parse(res.user.encryptedPrivateKey ?? ''), password);
      nav('/letters', { replace: true });
    } catch (err) {
      if (err instanceof SecureContextError) {
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not create the account. Try again.');
      }
      setBusy(false);
    }
  };

  return (
    <div className="card auth-card">
      <h1>Start a correspondence</h1>
      <p className="muted">
        Your encryption key is created here, on your device. We never see it.
      </p>

      {!cryptoOk && (
        <p className="alert" role="alert">
          This page is not a secure context, so your browser will not let PenPal generate an
          encryption key. Serve the app over HTTPS (or open it on localhost) and try again.
        </p>
      )}

      <form onSubmit={submit} noValidate>
        <Field
          id="username"
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          maxLength={64}
          required
        />
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
          autoComplete="new-password"
          hint="Also the key that unlocks your letters. There is no reset."
          required
        />
        <Field
          id="confirm"
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          required
        />

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        <button className="primary" type="submit" disabled={busy || !cryptoOk}>
          {busy ? 'Creating your key…' : 'Create account'}
        </button>
      </form>

      <p className="muted">
        Already writing to someone? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}