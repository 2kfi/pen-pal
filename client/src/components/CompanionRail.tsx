import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { usePairing } from '../stores/pairing';
import { useLetters } from '../stores/letters';

/**
 * The correspondence rail.
 *
 * DESIGN-UPDATED.md §3 specifies a friends sidebar: avatars, unread markers,
 * country lines, an independent scroll. PenPal's version of a friends list is
 * one person - the product pairs exactly two accounts and refuses the rest -
 * so the rail becomes the single row the product actually has, and the honest
 * empty state for people still waiting for theirs.
 *
 * It is a `<nav>` because it navigates; the row and the empty state both link
 * somewhere with a name, and the unread badge is a number plus the word
 * "unread", because status is never colour-only.
 */
export default function CompanionRail() {
  const partner = usePairing((s) => s.partner);
  const unread = useLetters((s) => s.unreadCount());
  const inTransit = useLetters((s) => s.inTransitCount());

  // The rail is the only surface that shows the partner on every visit, so it
  // cannot depend on the pairing page having been opened first: fetch once on
  // mount when the store is cold, quietly, and let the empty state stand until
  // the answer arrives.
  useEffect(() => {
    if (!partner) void usePairing.getState().refresh();
  }, [partner]);

  return (
    <nav className="companion-rail" aria-label="Your correspondence">
      <h2 className="rail-title">Correspondence</h2>

      {partner ? (
        <Link to="/letters" className="companion-row" aria-label={`Open your letters with ${partnerName(partner)}`}>
          <Avatar name={partnerName(partner)} size={38} />
          <span className="companion-meta">
            <span className="companion-name">{partnerName(partner)}</span>
            <span className="companion-status">
              {inTransit > 0 ? `${inTransit} travelling` : 'at rest'}
            </span>
          </span>
          {unread > 0 && (
            <span className="companion-unread">
              {unread}
              <span className="visually-hidden"> unread</span>
            </span>
          )}
        </Link>
      ) : (
        <Link to="/pairing" className="companion-row companion-row-empty">
          <span className="companion-avatar-empty" aria-hidden="true" />
          <span className="companion-meta">
            <span className="companion-name">No companion yet</span>
            <span className="companion-status">Pair with your pen pal</span>
          </span>
        </Link>
      )}

      <Link to="/compose" className="button primary rail-compose">
        Write a letter
      </Link>
    </nav>
  );
}

function partnerName(partner: { friendly_name?: string | null; username: string }): string {
  return partner.friendly_name || partner.username;
}
