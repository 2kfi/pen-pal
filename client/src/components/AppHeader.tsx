import { NavLink } from 'react-router-dom';
import Avatar from './Avatar';
import IconButton from './IconButton';
import { useAuth } from '../stores/auth';

/**
 * The 48px application header.
 *
 * Design: DESIGN-UPDATED.md §3 - full-bleed bar, bottom border, postal mark
 * plus wordmark on the left, compact actions on the right, never wrapping to
 * two rows. PenPal's version keeps four visible destinations as words (the
 * product has exactly four, and labelling beats de-labelling at this count),
 * while the three *actions* - compose, theme, account - become icon buttons so
 * the right edge stays calm.
 *
 * The compose action navigates; the theme action toggles; the avatar is the
 * account entry point and is a button, not a link, because its one behaviour is
 * leaving - there is no profile page to visit.
 */
export default function AppHeader({
  theme,
  onToggleTheme,
  onSignOut,
}: {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onSignOut: () => void;
}) {
  const name = useAuth((s) => s.user?.friendly_name || s.user?.username || '');

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <NavLink to="/letters" className="brand" aria-label="PenPal, your letters">
          <PostalMark />
          <span className="brand-word">PenPal</span>
        </NavLink>

        <nav aria-label="Primary">
          <NavLink to="/letters">Letters</NavLink>
          <NavLink to="/pairing">Invite</NavLink>
          <NavLink to="/play">Play</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>

        <div className="app-header-actions">
          <NavLink to="/compose" className="icon-btn compose-btn" aria-label="Write a letter">
            <IconCompose />
            <span className="icon-btn-word">Write</span>
          </NavLink>
          <IconButton
            label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={onToggleTheme}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </IconButton>
          <IconButton label={`Account: sign out (${name || 'signed in'})`} onClick={onSignOut}>
            <Avatar name={name || 'You'} size={28} />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

/** The pressed-disc mark from the favicon, at in-bar size. Words, not detail. */
function PostalMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false" className="brand-mark">
      <circle cx="11" cy="11" r="9.5" fill="var(--accent)" />
      <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--accent-ink)" strokeWidth="1.2" strokeDasharray="2 3" />
    </svg>
  );
}

const STROKE = 1.5;

function IconCompose() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2" y="4" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M2.5 5.5 10 11l7.5-5.5" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path
        d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M16 4l-1.4 1.4M5.4 14.6 4 16M16 16l-1.4-1.4M5.4 5.4 4 4"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </svg>
  );
}
