import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useTheme } from '../stores/theme';
import MiniPlayer from './MiniPlayer';
import NotifBell from './NotifBell';

export default function Layout() {
  const logout = useAuth((s) => s.logout);
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const onLogout = () => {
    logout();
    nav('/login');
  };
  return (
    <>
      <header className="topbar">
        <span className="brand">PenPal</span>
        <nav>
          <NavLink to="/letters">Write</NavLink>
          <NavLink to="/pairing">Invite</NavLink>
          <NavLink to="/games">Play</NavLink>
          <NavLink to="/media">Watch</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <NotifBell />
        <button onClick={toggle} title="toggle theme">
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        <button onClick={onLogout}>Logout</button>
      </header>
      <main>
        <Outlet />
      </main>
      <MiniPlayer />
    </>
  );
}
