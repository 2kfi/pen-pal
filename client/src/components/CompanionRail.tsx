import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { usePairing } from '../stores/pairing';
import { useLetters } from '../stores/letters';
import { useAuth } from '../stores/auth';
import { isInTransit, isUnread } from '../lib/sync';

/**
 * The correspondence rail.
 *
 * DESIGN-UPDATED.md §3 specifies a friends sidebar: avatars, unread markers,
 * country lines, an independent scroll. PenPal's version of a friends list is
 * now the pals joined to the switcher below it — one open correspondence at a
 * time, and a dial per pen pal when there is more than one. The honest empty
 * state for people still waiting for theirs is unchanged.
 *
 * It is a `<nav>` because it navigates; the row and the empty state both link
 * somewhere with a name, and the unread badge is a number plus the word
 * "unread", because status is never colour-only.
 */
export default function CompanionRail() {
  const partner = usePairing((s) => s.partner);
  const partners = usePairing((s) => s.partners);
  const items = useLetters((s) => s.items);
  const me = useAuth((s) => s.user);

  // The counts read the ACTIVE correspondence, not the whole archive: two pals
  // with travelling letters are two numbers in two places, never one summed.
  const palId = partner?.id ?? null;
  const mine = (l: { sender_id: number; recipient_id: number }) =>
    palId !== null && (l.sender_id === palId || l.recipient_id === palId);
  const unread = items.filter((l) => mine(l) && isUnread(l, me?.id)).length;
  const inTransit = items.filter((l) => mine(l) && isInTransit(l)).length;

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
              <span className="sr-only"> unread</span>
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

      {/* The switcher exists only when there is more than one: the rail's
          whole point is calm, and a one-item switcher is decoration. Each dial
          is the pal's avatar; pressed state marks the active correspondence,
          and an unread pal carries its own count — per channel, never summed. */}
      {partners.length > 1 && (
        <div className="pal-switcher" role="group" aria-label="Switch pen pal">
          {partners.map((p) => {
            const palUnread = items.filter(
              (l) => (l.sender_id === p.id || l.recipient_id === p.id) && isUnread(l, me?.id),
            ).length;
            return (
              <button
                key={p.id}
                type="button"
                className={`pal-dial ${p.id === partner?.id ? 'pal-dial-active' : ''}`}
                aria-pressed={p.id === partner?.id}
                title={`Correspond with ${partnerName(p)}`}
                onClick={() => usePairing.getState().setActivePal(p.id)}
              >
                <Avatar name={partnerName(p)} size={28} />
                {palUnread > 0 && p.id !== partner?.id && (
                  <span className="pal-dial-unread">
                    {palUnread}
                    <span className="sr-only"> unread from {partnerName(p)}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <Link
        to={partner ? '/letters/new' : '/pairing'}
        className="button primary rail-compose"
      >
        {partner ? 'Write a letter' : 'Invite your pen pal'}
      </Link>
    </nav>
  );
}

function partnerName(partner: { friendly_name?: string | null; username: string }): string {
  return partner.friendly_name || partner.username;
}
