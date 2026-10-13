import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, ApiError } from '../lib/api';
import { SecureContextError, sealLetter } from '../lib/crypto';
import { useAuth } from '../stores/auth';
import { usePairing } from '../stores/pairing';
import Field from '../components/Field';

const DRAFT_KEY = 'pp_draft';

/**
 * Compose.
 *
 * The single most important behaviour in this file: **there is no plaintext
 * fallback**. v0.0.2 wrapped encryption in a try/catch whose catch block silently
 * posted the raw body, so any crypto failure quietly downgraded a user's private
 * letter to plaintext on the server while the UI still claimed E2E.
 *
 * Here, failure means the letter is not sent. Ever.
 */
export default function Compose() {
  const nav = useNavigate();
  const me = useAuth((s) => s.user);
  const { partner, loading, refresh } = usePairing();

  const [body, setBody] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [deliverAfter, setDeliverAfter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, body);
  }, [body]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

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

      await api('/api/letters/send', {
        method: 'POST',
        body: JSON.stringify({
          recipientId: partner.id,
          encryptedContent: JSON.stringify(envelope),
          deliveredAt: deliverAfter ? new Date(deliverAfter).toISOString() : null,
        }),
      });

      localStorage.removeItem(DRAFT_KEY);
      nav('/letters', { replace: true });
    } catch (err) {
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
    <div className="compose">
      <h1>Write a letter</h1>

      {!partner && !loading && (
        <p className="muted">
          You have no one to write to yet. <a href="/pairing">Send an invite</a>.
        </p>
      )}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="letter-body">Letter</label>
          <textarea
            id="letter-body"
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
          <button className="primary" type="submit" disabled={busy || !body.trim() || !partner}>
            {busy ? 'Sealing…' : 'Seal and send'}
          </button>
        </div>

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
          <article className="reader" dangerouslySetInnerHTML={{ __html: preview }} />
        </details>
      )}
    </div>
  );
}