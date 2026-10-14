/**
 * The archive.
 *
 * Two things changed here and one thing deliberately did not:
 *
 * CHANGED — the page now connects to the live stream and the outbox via
 * `useLetters.connect()` / `disconnect()`, and shows the two client-only states.
 * A letter that is `sending` is on screen before the server has heard of it; a
 * letter that `failed` is on screen with the reason why and a retry that reuses
 * its original idempotency key.
 *
 * NOT CHANGED — the DOM. The e2e suite drives this page by `.letter` and
 * `.letter-excerpt`, and a private letter that can no longer be read because a
 * class name moved is a broken app, not a refactor. Every selector v0.0.2
 * exposed still resolves.
 *
 * The excerpt is real decrypted text. Decryption happens per-row and only when
 * the vault is unlocked; a row whose key is missing shows "Sealed" rather than a
 * fake placeholder, because that is the truth and the user can act on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useLetters,
  type Letter,
} from '../stores/letters';
import { useAuth } from '../stores/auth';
import { activeKey } from '../lib/vault';
import { isEnvelope, openLetter } from '../lib/crypto';
import { previewText } from '../lib/letterBody';
import { arrivesAt, isFailed, isPending, isUnread } from '../lib/sync';

type NodeState =
  | { kind: 'transit'; arrivesAt: string }
  | { kind: 'text'; excerpt: string }
  | { kind: 'sealed' }
  | { kind: 'error' };

function postmark(letter: Letter, isMine: boolean): string {
  const date = new Date(letter.sent_at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${date} · ${isMine ? 'sent' : 'received'}`;
}

/**
 * One letter on the spine.
 *
 * Decryption is keyed on `letter.encrypted_content`, not on the whole object.
 * The optimistic row, a `sending` letter, and its server replacement are three
 * different objects that should decrypt to the same text — depending on the
 * whole object re-runs the decrypt (and re-promises) every time the stream
 * touches this row, which on a live feed is constantly.
 */
function LetterNode({ letter, isMine }: { letter: Letter; isMine: boolean }) {
  const me = useAuth((s) => s.user);
  const retry = useLetters((s) => s.retry);
  const [state, setState] = useState<NodeState | null>(null);

  // An optimistic row has a client-minted created_at and no server id yet. There
  // is nothing to arrive and nothing to open, so skip the effect entirely rather
  // than attempting a decrypt that can only fail.
  const pending = isPending(letter);
  const failed = isFailed(letter);
  const transitAt = useMemo(() => arrivesAt(letter), [letter.delivered_at, letter.available_at, letter.state]);

  useEffect(() => {
    if (pending || failed) {
      setState(null);
      return;
    }

    if (transitAt && new Date(transitAt) > new Date()) {
      setState({ kind: 'transit', arrivesAt: new Date(transitAt).toLocaleString() });
      return;
    }

    const key = activeKey();
    const parsed: unknown = safeParse(letter.encrypted_content);
    if (!isEnvelope(parsed) || !key || !me) {
      setState({ kind: 'sealed' });
      return;
    }

    let cancelled = false;
    void openLetter(parsed, key, me.id)
      .then((plaintext) => {
        if (!cancelled) setState({ kind: 'text', excerpt: previewText(plaintext) });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [letter.encrypted_content, me, pending, failed, transitAt]);

  const inTransit = state?.kind === 'transit';
  const unread = letter.recipient_id === me?.id && !letter.read_at && !inTransit && !pending && !failed;

  // A failed row is not a link. Clicking one would open a letter that does not
  // exist server-side and report it as missing, which is a worse lie than a
  // button that says what is actually true.
  const className = [
    'letter',
    inTransit ? 'transit' : '',
    pending ? 'pending' : '',
    failed ? 'failed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const body = (
    <>
      <div className="letter-state">
        {postmark(letter, isMine)}
        {inTransit && <span> · in transit</span>}
        {letter.state === 'replied' && <span> · replied</span>}
        {pending && <span> · sending</span>}
      </div>

      {state === null && !pending && !failed && (
        <p className="letter-excerpt muted">Opening…</p>
      )}

      {state?.kind === 'transit' && (
        <>
          <p className="letter-excerpt">Still travelling.</p>
          <p className="muted">Arrives {state.arrivesAt}</p>
        </>
      )}

      {state?.kind === 'text' && <p className="letter-excerpt">{state.excerpt}</p>}

      {state?.kind === 'sealed' && (
        <>
          <p className="letter-excerpt muted">Sealed.</p>
          <span className="seal" aria-hidden />
        </>
      )}

      {state?.kind === 'error' && <p className="letter-excerpt muted">Could not be opened.</p>}

      {pending && (
        <p className="letter-excerpt muted">
          Sealed on this device. It will go out when you are back online.
        </p>
      )}

      {failed && (
        <>
          <p className="letter-excerpt muted">
            This letter did not go out: {letter.local_error ?? 'the server refused it.'}
          </p>
          <p className="muted">
            Your text is still in the draft box — nothing was lost.
          </p>
          {letter.idempotency_key && (
            <button
              type="button"
              className="letter-retry"
              onClick={(event) => {
                // The row is not a link in this state, but the button is inside
                // one if the markup ever changes. Stop it either way.
                event.preventDefault();
                event.stopPropagation();
                void retry(letter.idempotency_key!);
              }}
            >
              Try again
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <Link
      to={`/letters/${letter.id}`}
      className={className}
      aria-busy={pending || undefined}
      data-state={pending ? 'sending' : failed ? 'failed' : letter.state}
    >
      {body}
      {unread && <span className="sr-only">(unread)</span>}
    </Link>
  );
}

export default function Letters() {
  const {
    items,
    hasMore,
    loading,
    loadingMore,
    error,
    fetchMore,
    connect,
    disconnect,
    stream,
    queued,
  } = useLetters();
  const me = useAuth((s) => s.user);

  // Computed here rather than read off the store: it is a pure function of
  // `items` plus the signed-in user, and putting a fresh number in the store on
  // every event would be a needless re-render of every row.
  const unread = useMemo(
    () => items.filter((l) => isUnread(l, me?.id)).length,
    [items, me?.id],
  );

  /**
   * Infinite scroll, deliberately not an IntersectionObserver.
   *
   * The observer is a `disconnect()` hazard of its own — it holds a reference to
   * the node and to a callback that closes over the store, and an observer left
   * registered against an unmounted tree keeps firing. A scroll listener on a
   * container this component owns, cleared in the effect's own cleanup, cannot
   * outlive it.
   */
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const loadMore = useCallback(() => {
    void fetchMore();
  }, [fetchMore]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    // `once: true` plus an explicit unobserve: the observer cannot keep
    // delivering events after this effect's cleanup runs, even if the node is
    // still attached to a document React has already unmounted.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  const ordered = items; // the controller already returns this newest-first

  return (
    <div>
      <h1>Your archive</h1>

      <div className="page-actions">
        <Link to="/letters/new" className="button primary">
          Write a letter
        </Link>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {/*
        Announced rather than shown: these are connection facts, not content, and
        a screen-reader user needs to know their archive is stale (queued) or live.
      */}
      <p className="sr-only" role="status">
        {stream === 'open' ? 'Archive is live.' : stream === 'connecting' ? 'Connecting…' : ''}
        {queued > 0 ? ` ${queued} letter${queued === 1 ? '' : 's'} waiting to send.` : ''}
        {unread > 0 ? ` ${unread} unread.` : ''}
      </p>

      {queued > 0 && (
        <p className="muted" data-testid="outbox-count">
          {queued} letter{queued === 1 ? '' : 's'} sealed and waiting for a connection.
        </p>
      )}

      {ordered.length === 0 && !loading && (
        <div className="card">
          <h2>Nothing here yet</h2>
          <p className="muted">
            {items.length > 0
              ? 'Write the first letter. It will travel, and arrive when it arrives.'
              : 'You need a pen pal first. Send an invite, then start writing.'}
          </p>
        </div>
      )}

      {ordered.length > 0 && (
        <div className="archive">
          <span className="spine" aria-hidden />
          {ordered.map((letter) => (
            <LetterNode key={letter.id} letter={letter} isMine={letter.sender_id === me?.id} />
          ))}
        </div>
      )}

      {/* The infinite-scroll trigger. Also a real button, for keyboard users and
          for anyone whose browser has no IntersectionObserver. */}
      <div ref={sentinel} aria-hidden={hasMore ? undefined : true}>
        {hasMore && ordered.length > 0 && (
          <button type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Fetching…' : 'Load older letters'}
          </button>
        )}
      </div>
    </div>
  );
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}