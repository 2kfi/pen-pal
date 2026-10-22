import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import AppHeader from './AppHeader';
import CompanionRail from './CompanionRail';
import { useAuth } from '../stores/auth';
import { useTheme } from '../stores/theme';
import { useVault, activeKey } from '../lib/vault';
import Unlock from '../pages/Unlock';

/**
 * App shell.
 *
 * Design: DESIGN-UPDATED.md §3 - header on top, then the two-column shell: the
 * correspondence rail on the left, the page on the right, at 1180px of
 * container. On narrow screens the rail collapses from a column into a strip
 * above the content, which is the reachable version of the drawer the
 * reference asks for: one row, always at the top, no overlay state machine
 * built for a list that can only ever contain one item.
 *
 * v0.0.2 had no landmarks at all. Those stay, and the wide grid is opt-in per
 * route: reading pages keep the 68ch measure, correspondence pages go wide so
 * the letter grid has room to be a grid.
 */
const WIDE_ROUTES = ['/letters', '/compose', '/play'];

export default function Layout() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const { theme, toggle } = useTheme();
  const status = useVault((s) => s.status);
  const nav = useNavigate();
  const pathname = useLocation().pathname;

  const onSignOut = () => {
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    signOut();
    nav('/login', { replace: true });
  };

  // Signed in but the key is not resident: nothing in the app can be read yet.
  // Gate here rather than scattering "please unlock" states across every page.
  if (status !== 'unlocked' || !activeKey()) {
    return (
      <>
        <AppHeader theme={theme} onToggleTheme={toggle} onSignOut={onSignOut} />
        <main id="main">
          <Unlock />
        </main>
      </>
    );
  }

  const wide = WIDE_ROUTES.some((r) => pathname.startsWith(r));

  return (
    <div className="app-shell-root">
      <a className="skip-link" href="#main">
        Skip to your letters
      </a>

      <AppHeader theme={theme} onToggleTheme={toggle} onSignOut={onSignOut} />

      <div className={`app-shell ${wide ? 'app-shell-wide' : ''}`}>
        <aside className="shell-rail">
          <CompanionRail />
          <footer className="rail-footer">
            Signed in as
            {' '}
            {user?.friendly_name || user?.username}
          </footer>
        </aside>
        <main id="main" className={wide ? 'main-wide' : ''}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
