import { useEffect, useState } from 'react';
import { usePairing } from '../stores/pairing';
import Field from '../components/Field';

/**
 * Pairing.
 *
 * Rebuilt against the token system: no inline styles, no icon font, real labels.
 * The PID is the only handle two strangers have on each other, so it gets the
 * postmark treatment and a copy button rather than being buried in a sentence.
 */
export default function Pairing() {
  const { incoming, outgoing, partners, partner, myPid, loading, error, refresh, request, accept, reject, unpair, setActivePal } =
    usePairing();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const copyPid = async () => {
    if (!myPid) return;
    try {
      await navigator.clipboard.writeText(myPid);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the PID is on screen either way.
      setMsg('Copying is blocked in this browser — type your PID out instead.');
    }
  };

  return (
    <div className="stack">
      <h1>Your pen pals</h1>

      <section className="card section">
        <h2>Your PID</h2>
        <p className="muted">Anyone with this can send you an invite. It is the only way two strangers find each other here.</p>
        <div className="row">
          <span className="pid-badge">{myPid ?? (loading ? '…' : 'unknown')}</span>
          <button type="button" onClick={() => void copyPid()} disabled={!myPid}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </section>

      {partners.length > 0 && (
        <section className="card section">
          <h2>Writing to ({partners.length})</h2>
          {partners.map((p) => (
            <div key={p.id} className="row invite-row">
              <span className="partner-name">{p.friendly_name || p.username}</span>
              <span className="postmark">{p.pid}</span>
              {p.id !== partner?.id && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => setActivePal(p.id), 'Switched.')}
                >
                  Open
                </button>
              )}
              {p.id === partner?.id && <span className="muted">open now</span>}
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => unpair(p.id), 'You are unpaired.')}
              >
                Unpair
              </button>
            </div>
          ))}
          <p className="muted">
            Each pal is its own correspondence — its archive, rituals and chess board are separate. Unpairing one never touches the others.
          </p>
        </section>
      )}

      <section className="card section">
        <h2>Invite someone</h2>
        <Field
          id="target-pid"
          label="Their PID"
          value={target}
          onChange={(v) => setTarget(v.toUpperCase().trim())}
          maxLength={6}
          placeholder="ABC123"
          hint="Six characters, letters and numbers."
        />
        <button
          className="primary"
          type="button"
          disabled={busy || target.length !== 6}
          onClick={() =>
            void run(async () => {
              await request(target);
              setTarget('');
            }, 'Invite sent.')
          }
        >
          Send invite
        </button>
      </section>

      <section className="card section">
        <h2>Invitations ({incoming.length})</h2>
        {incoming.length === 0 && <p className="muted">No one has invited you yet.</p>}
        {incoming.map((r) => (
          <div key={r.id} className="row invite-row">
            <span className="partner-name">{r.friendly_name || r.username}</span>
            <span className="postmark">{r.pid}</span>
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void run(() => accept(r.id), 'Paired.')}
            >
              Accept
            </button>
            <button type="button" disabled={busy} onClick={() => void run(() => reject(r.id), 'Declined.')}>
              Decline
            </button>
          </div>
        ))}
      </section>

      {outgoing.length > 0 && (
        <section className="card section">
          <h2>Sent ({outgoing.length})</h2>
          {outgoing.map((o) => (
            <p key={o.id} className="muted">
              <span className="postmark">{o.target_pid}</span> — {o.status}
            </p>
          ))}
        </section>
      )}

      {(error || msg) && (
        <p className={error ? 'alert' : 'muted'} role={error ? 'alert' : 'status'}>
          {error || msg}
        </p>
      )}
    </div>
  );
}