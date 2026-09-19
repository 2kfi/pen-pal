import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useAuth((s) => s.login);
  const nav = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error('Login failed');
      const data = await res.json();
      login(data.token, data.user);
      nav('/letters');
    } catch {
      setError('Login failed — check credentials or API proxy.');
    }
  };

  return (
    <div className="card">
      <h1>Login</h1>
      <form onSubmit={submit} style={{ display: 'grid', gap: '0.5rem' }}>
        <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="primary" type="submit">
          Login
        </button>
      </form>
      {error && <p className="muted">{error}</p>}
    </div>
  );
}
