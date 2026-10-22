import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, ApiError } from '../lib/api';
import { SecureContextError, sealLetter } from '../lib/crypto';
import { useAuth } from '../stores/auth';
import { usePairing } from '../stores/pairing';
import Field from '../components/Field';
import StampArt from '../components/StampArt';
import SealAnimation, { usePrefersReducedMotion, type SealMoment } from '../components/SealAnimation';

const DRAFT_KEY = 'pp_draft';

/**
 * Liveness guard, not choreography. If GSAP's callback never arrives — an
 * interrupted context, a tab that was backgrounded, a timeline killed by a
 * re-render — the send must still complete. Comfortably longer than the 700ms
 * the moment is designed to take, so in normal operation it is never the thing
 * that ends the wait.
 */
const SEAL_FALLBACK_MS = 2500;

/**
 * Compose.
 *
 * The single most important behaviour in this file: **there is no plaintext
 * fallback**. v0.0.2 wrapped encryption in a try/catch whose catch block silently
 * posted the raw body, so any crypto failure quietly downgraded a user's private
 * letter to plaintext on the server while the UI still claimed E2E.
 *
 * Here, failure means the letter is not sent. Ever.
 *
 * The seal animation changes *when* the network is told, never *what* is sent
 * to it. Encryption still happens first and locally; the animation only delays
 * the POST until the letter has been seen leaving, and a failed POST brings the
 * letter back on screen before the error is shown.
 */
export default function Compose() {
  const nav = useNavigate();
  const me = useAuth((s) => s.user);
  const { partner, loading, refresh } = usePairing();

  const [body, setBody] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [deliverAfter, setDeliverAfter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [moment, setMoment] = useState<SealMoment | null>(null);

  const sendButton = useRef<HTMLButtonElement>(null);
  const settleSeal = useRef<(() => void) | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);

  /** False once this screen is gone: never resume a send into a dead component. */
  const alive = useRef(true);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, body);
  }, [body]);

  /**
   * Plays the seal moment and resolves when it is over.
   *
   * Under `prefers-reduced-motion` there is no moment to play — the whole
   * point of that setting — so this resolves immediately and the letter is
   * simply sent, exactly as it was before the animation existed.
   */
  const playSeal = useCallback((m: SealMoment) => {
    if (reducedMotionRef.current) return Promise.resolve();

    return new Promise<void>((resolve) => {
      // Never leave an earlier wait hanging if something re-enters here.
      settleSeal.current?.();

      const finish = () => {
        window.clearTimeout(timer);
        settleSeal.current = null;
        resolve();
      };
      const timer = window.setTimeout(finish, SEAL_FALLBACK_MS);

      settleSeal.current = finish;
      setMoment(m);
    });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    // A disabled button does not stop the browser submitting the form from
    // another field, so a second submit can still arrive mid-send. One letter,
    // one animation: refuse the duplicate rather than post it.
    if (busy) return;

    if (!partner) {
      setError('You are not writing to anyone yet. Send an invite first.');
      return;
    }
    if (!me?.publicKey) {
      setError('Your public key is missing. Sign out and back in to reload your profile.');
      return;
    }
    if (!partner.publicKey) {
      setError(`${partner.username} has not published a key yet, so this letter cannot be encrypted.`);
      return;
    }

    setBusy(true);
    try {
      const sentAt = new Date().toISOString();

      // Throws on anything unexpected — and there is no catch that sends `body`.
      const envelope = await sealLetter(body, {
        senderId: me.id,
        recipientId: partner.id,
        senderPublicKey: JSON.parse(me.publicKey),
        recipientPublicKey: JSON.parse(partner.publicKey),
        sentAt,
      });
      if (!alive.current) return;

      // The letter is sealed on this device before it moves, and it leaves
      // before the network hears about it. docs/DESIGN.md §1: a sent letter
      // should arrive, not appear — so nothing changes on screen until the
      // letter is genuinely on its way.
      await playSeal('departing');
      if (!alive.current) return;

      try {
        await api('/api/letters/send', {
          method: 'POST',
          body: JSON.stringify({
            recipientId: partner.id,
            encryptedContent: JSON.stringify(envelope),
            deliveredAt: deliverAfter ? new Date(deliverAfter).toISOString() : null,
          }),
        });
      } catch (err) {
        // It left and did not arrive. Bring it back on screen before saying so,
        // so the user is never looking at a letter that has left the page while
        // the draft — still untouched in localStorage — sits right here.
        await playSeal('returning');
        throw err;
      }

      if (!alive.current) return;

      // Only now does the draft go. It survives every failure path above.
      localStorage.removeItem(DRAFT_KEY);
      setMoment(null);
      nav('/letters', { replace: true });
    } catch (err) {
      setMoment(null);
      if (err instanceof SecureContextError) {
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof SyntaxError) {
        setError('A public key could not be parsed, so the letter was not sent.');
      } else {
        setError(
          'The letter could not be encrypted, so it was NOT sent. ' +
            'Your text is still in the draft box — nothing left this device unencrypted.',
        );
      }
      setBusy(false);
    }
  };

  const preview = DOMPurify.sanitize(marked.parse(body || '*Nothing written yet*') as string);

  return (
    <div className={`compose${busy ? ' is-sealing' : ''}`}>
      <div className="compose-head">
        <h1>Write a letter</h1>
        {/* The draft is franked before it exists: one stamp, cut from tokens and
            seeded by the constant draft id, identical for every compose page.
            Decorative; the stamp that identifies a sent letter is stamped on
            the card in the archive, seeded by that letter's real id. */}
        <StampArt seed="compose" />
      </div>

      {!partner && !loading && (
        <p className="muted">
          You have no one to write to yet. <a href="/pairing">Send an invite</a>.
        </p>
      )}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="letter-body">Letter</label>
          {/* dir="auto": direction follows the writer's first strong
              character, matching what the reader will resolve. */}
          <textarea
            id="letter-body"
            dir="auto"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Dear friend…"
            rows={14}
            aria-describedby="letter-format-hint"
          />
          <p className="field-hint" id="letter-format-hint">
            Markdown works. Only you and {partner?.friendly_name || partner?.username || 'your pen pal'} can read this.
          </p>
        </div>

        <div className="compose-actions">
          <Field
            id="deliver-after"
            label="Deliver no earlier than"
            type="date"
            value={deliverAfter}
            onChange={setDeliverAfter}
          />
          <button
            ref={sendButton}
            className="primary"
            type="submit"
            disabled={busy || !body.trim() || !partner}
            aria-busy={busy}
          >
            {busy ? 'Sealing…' : 'Seal and send'}
          </button>
        </div>

        {/* The animation is decorative and aria-hidden, so the state it depicts
            is announced here instead. */}
        <p className="sr-only" role="status">
          {busy ? 'Sealing your letter and sending it.' : ''}
        </p>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
      </form>

      {body.trim() && (
        <details className="preview">
          <summary>Preview</summary>
          {/* Sanitised: marked() output is passed through DOMPurify before it is
              ever handed to dangerouslySetInnerHTML. */}
          <article className="reader" dir="auto" dangerouslySetInnerHTML={{ __html: preview }} />
        </details>
      )}

      <SealAnimation
        moment={moment}
        originRef={sendButton}
        onSettled={() => setMoment(null)}
      />
    </div>
  );
}