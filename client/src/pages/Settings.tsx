import { useState } from 'react';
import { useTheme } from '../stores/theme';
import { useAuth } from '../stores/auth';
import { useVault } from '../lib/vault';
import { api, ApiError } from '../lib/api';
import Avatar from '../components/Avatar';

export default function Settings() {
  const { theme, set } = useTheme();
  const user = useAuth((s) => s.user);
  const { lock } = useVault();
  const [name, setName] = useState(user?.friendly_name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState('');

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

  const copyPid = async () => {
    if (!user?.pid) return;
    setCopyError('');
    try {
      await navigator.clipboard.writeText(user.pid);
      setCopied('Copied');
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopyError('Copying is blocked in this browser. Read it aloud instead.');
    }
  };

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="card section" aria-labelledby="settings-profile">
        <h2 id="settings-profile">Your profile</h2>
        {/* The monogram is the same one the rail draws, one size up: your name is
            the thing the site knows, and the avatar never claims more than that. */}
        <div className="settings-profile-head">
          <Avatar name={name || user?.username || 'You'} size={56} />
          <div className="field field-grow">
            <label htmlFor="display-name">Display name</label>
            <input
              id="display-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
            />
          </div>
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

      <section className="card section" aria-labelledby="settings-theme">
        <h2 id="settings-theme">Theme</h2>
        {/* Two authored themes, both contrast-checked (docs/DESIGN.md §4). A
            pressed radio gets the wash and the accent underline here, so the
            accent fill stays available to the one primary action on the page. */}
        <div role="radiogroup" aria-label="Theme" className="seg">
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            onClick={() => set('dark')}
          >
            Desk at night
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            onClick={() => set('light')}
          >
            Letter on the table
          </button>
        </div>
      </section>

      <section className="card section" aria-labelledby="settings-key">
        <h2 id="settings-key">Your key</h2>
        <p className="muted">
          Anyone with your PID can send you a pairing request. It is an address, not a secret.
        </p>
        <div className="row">
          <span className="pid-badge">{user?.pid ?? 'loading'}</span>
          <button type="button" className="button" onClick={() => void copyPid()}>
            {copied || 'Copy'}
          </button>
        </div>
        {copyError && (
          <p className="muted" role="status">
            {copyError}
          </p>
        )}
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
