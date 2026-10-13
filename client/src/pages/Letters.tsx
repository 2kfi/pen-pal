import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { sortNewestFirst, useLetters, type Letter } from '../stores/letters';
import { useAuth } from '../stores/auth';
import { activeKey } from '../lib/vault';
import { isEnvelope, openLetter } from '../lib/crypto';
import { previewText } from '../lib/letterBody';

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
 * The excerpt is real decrypted text, not a placeholder. v0.0.2 showed
 * "(encrypted letter)" for every row because nothing ever decrypted anything.
 */
function LetterNode({ letter, isMine }: { letter: Letter; isMine: boolean }) {
  const me = useAuth((s) => s.user);
  const [state, setState] = useState<NodeState | null>(null);

  useEffect(() => {
    const key = activeKey();

    if (letter.delivered_at && new Date(letter.delivered_at) > new Date()) {
      setState({
        kind: 'transit',
        arrivesAt: new Date(letter.delivered_at!).toLocaleString(),
      });
      return;
    }

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
  }, [letter, me]);

  const inTransit = state?.kind === 'transit';

  return (
    <Link to={`/letters/${letter.id}`} className={`letter${inTransit ? ' transit' : ''}`}>
      <div className="letter-state">
        {postmark(letter, isMine)}
        {inTransit && <span> · in transit</span>}
      </div>

      {state === null && <p className="letter-excerpt muted">Opening…</p>}

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
    </Link>
  );
}

export default function Letters() {
  const { items, hasMore, loading, error, fetchMore, loaded } = useLetters();
  const me = useAuth((s) => s.user);

  useEffect(() => {
    if (!loaded && !loading) void fetchMore();
  }, [loaded, loading, fetchMore]);

  const ordered = sortNewestFirst(items);
  const hasPartner = useLettersReady();

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

      {ordered.length === 0 && !loading && (
        <div className="card">
          <h2>Nothing here yet</h2>
          <p className="muted">
            {hasPartner
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

      {hasMore && ordered.length > 0 && (
        <button type="button" onClick={() => void fetchMore()} disabled={loading}>
          {loading ? 'Fetching…' : 'Load older letters'}
        </button>
      )}
    </div>
  );
}

/** Cheap pairing probe so the empty state can say something useful. */
function useLettersReady(): boolean {
  const { items } = useLetters();
  return items.length > 0;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}