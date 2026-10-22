import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLetters, type Letter } from '../stores/letters';
import { useAuth } from '../stores/auth';
import { DecryptionError, isEnvelope, openLetter, type LetterEnvelope } from '../lib/crypto';
import { activeKey } from '../lib/vault';
import { renderLetterBody } from '../lib/letterBody';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'sealed' }
  | { kind: 'in_transit'; arrivesAt: string }
  | { kind: 'opened'; html: string }
  | { kind: 'undecryptable'; reason: string };

function postmark(letter: Letter): string {
  return new Date(letter.sent_at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function Reader() {
  const { id } = useParams();
  const me = useAuth((s) => s.user);
  const { byId, fetchMore, loaded, loading } = useLetters();
  const letter = id ? byId(Number(id)) : undefined;
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    if (!loaded && !loading) void fetchMore(50);
  }, [loaded, loading, fetchMore]);

  useEffect(() => {
    const key = activeKey();
    if (!me) return;

    if (!letter) {
      setState(loading ? { kind: 'loading' } : { kind: 'missing' });
      return;
    }

    // Not addressed to us at all: do not attempt decryption, do not leak existence.
    if (letter.sender_id !== me.id && letter.recipient_id !== me.id) {
      setState({ kind: 'sealed' });
      return;
    }

    if (letter.delivered_at && new Date(letter.delivered_at) > new Date()) {
      setState({ kind: 'in_transit', arrivesAt: new Date(letter.delivered_at!).toLocaleString() });
      return;
    }

    const parsed: unknown = safeParse(letter.encrypted_content);
    if (!isEnvelope(parsed)) {
      setState({
        kind: 'undecryptable',
        reason:
          'This letter is not in a format this version can read. If you wrote it before the ' +
          'V2 encryption upgrade, it cannot be recovered.',
      });
      return;
    }

    const env: LetterEnvelope = parsed;
    void openLetter(env, key!, me.id)
      .then((plaintext) => setState({ kind: 'opened', html: renderLetterBody(plaintext) }))
      .catch((err: unknown) =>
        setState({
          kind: 'undecryptable',
          reason:
            err instanceof DecryptionError
              ? err.message
              : 'Something went wrong decrypting this letter.',
        }),
      );
  }, [letter, me, loading, loaded]);

  const envelope = useMemo(() => safeParse(letter?.encrypted_content ?? ''), [letter]);

  return (
    <article className="letter-read">
      <p className="postmark">
        {letter ? postmark(letter) : '—'}
        {letter && (
          <>
            {' · '}
            {letter.sender_id === me?.id ? 'sent by you' : 'from your pen pal'}
          </>
        )}
      </p>

      {state.kind === 'loading' && <p className="muted">Fetching…</p>}

      {state.kind === 'missing' && (
        <>
          <h1>Letter not found</h1>
          <p className="muted">It may not have arrived yet, or it may not be yours.</p>
          <Link to="/letters">Back to the archive</Link>
        </>
      )}

      {state.kind === 'sealed' && (
        <>
          <h1>Sealed</h1>
          <p className="muted">This letter was addressed to someone else.</p>
        </>
      )}

      {state.kind === 'in_transit' && (
        <>
          <h1>In transit</h1>
          <p className="muted">
            This letter is still travelling. It arrives {state.arrivesAt}.
          </p>
          <span className="transit-mark" aria-hidden />
        </>
      )}

      {state.kind === 'opened' && (
        <>
          {/* Sanitised by renderLetterBody. */}
          {/* dir="auto": the direction obeys the letter's own first strong
              character, so a letter written in Arabic or Hebrew reads right
              to left inside a left-to-right interface. */}
          <div className="reader" dir="auto" dangerouslySetInnerHTML={{ __html: state.html }} />
          <span className="seal" aria-hidden />
        </>
      )}

      {state.kind === 'undecryptable' && (
        <>
          <h1>Could not open</h1>
          <p className="alert" role="alert">
            {state.reason}
          </p>
        </>
      )}

      {state.kind === 'opened' && letter?.photo_paths && (
        <p className="muted">Attachments: {letter.photo_paths}</p>
      )}

      <p className="muted">
        <Link to="/letters">Back to the archive</Link>
      </p>

      {envelope !== null && (
        <details className="raw">
          <summary>Envelope metadata</summary>
          <pre>{JSON.stringify(redactEnvelope(envelope), null, 2)}</pre>
        </details>
      )}
    </article>
  );
}

/** Never dump ciphertext or wrapped keys into the DOM. */
function redactEnvelope(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const { ct, keys, ...rest } = value as Record<string, unknown>;
  return {
    ...rest,
    ct: `${String(ct).length} bytes of ciphertext`,
    keys: `${Object.keys(keys as object).length} wrapped keys`,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}