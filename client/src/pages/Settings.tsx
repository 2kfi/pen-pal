import { useTheme } from '../stores/theme';
import { useAuth } from '../stores/auth';
import { useVault } from '../lib/vault';
import { api, ApiError } from '../lib/api';
import { useState } from 'react';

export default function Settings() {
  const { theme, set } = useTheme();
  const user = useAuth((s) => s.user);
  const { lock } = useVault();
  const [name, setName] = useState(user?.friendly_name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    setSaved('');
    setError('');
    try {
      await api('/api/me', {
        method: 'PUT',
        body: JSON.stringify({ friendly_name: name, bio }),
      });
      await useAuth.getState().refreshProfile();
      setSaved('Saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    }
  };

  return (
    <div>
      <h1>Settings</h1>

      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <h2>Theme</h2>
        <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            onClick={() => set('dark')}
            className={theme === 'dark' ? 'primary' : undefined}
          >
            Desk at night
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            onClick={() => set('light')}
            className={theme === 'light' ? 'primary' : undefined}
          >
            Letter on the table
          </button>
        </div>
        {/* Two authored themes, both contrast-checked. v0.0.2 shipped 14 with
            inconsistent variables and no way to tell which were legible. */}
      </section>

      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <h2>Your profile</h2>
        <div className="field">
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
          />
        </div>
        <div className="field">
          <label htmlFor="bio">About you</label>
          <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxLength={256} />
        </div>
        <button className="primary" type="button" onClick={() => void save()}>
          Save
        </button>
        {saved && (
          <p className="muted" role="status">
            {saved}
          </p>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Your key</h2>
        <p className="muted">
          Your PID is <strong>{user?.pid}</strong>. Anyone with it can send you a pairing request.
        </p>
        <button type="button" onClick={lock}>
          Lock the archive
        </button>
        <p className="muted">
          Locking drops your decrypted key from memory. Reading resumes when you unlock again.
        </p>
      </section>
    </div>
  );
}