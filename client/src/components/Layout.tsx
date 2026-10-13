import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useTheme } from '../stores/theme';
import { useVault } from '../lib/vault';
import { activeKey } from '../lib/vault';
import { isSignedIn } from '../stores/auth';
import Unlock from '../pages/Unlock';
import { useEffect } from 'react';

/**
 * App shell.
 *
 * v0.0.2 had no landmarks at all — a bare <header> wrapping everything and no
 * <main>. This adds proper landmark roles, a skip link, and the vault gate.
 */
export default function Layout() {
  const logout = useAuth((s) => s.logout);
  const { theme, toggle } = useTheme();
  const status = useVault((s) => s.status);
  const nav = useNavigate();

  // Reconcile the persisted token with a live session on load. A stale token in
  // localStorage should land you on the sign-in screen, not a broken archive.
  useEffect(() => {
    if (!isSignedIn()) nav('/login', { replace: true });
  }, [nav]);

  const onLogout = () => {
    logout();
    nav('/login', { replace: true });
  };

  // Signed in but the key is not resident: nothing in the app can be read yet.
  // Gate here rather than scattering "please unlock" states across every page.
  if (status !== 'unlocked' || !activeKey()) {
    return (
      <>
        <main id="main">
          <Unlock />
        </main>
      </>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to your letters
      </a>

      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">PenPal</span>
          <nav aria-label="Primary">
            <NavLink to="/letters">Letters</NavLink>
            <NavLink to="/pairing">Invite</NavLink>
            <NavLink to="/play">Play</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="topbar-actions">
            <button
              type="button"
              onClick={toggle}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button type="button" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main id="main">
        <Outlet />
      </main>
    </>
  );
}