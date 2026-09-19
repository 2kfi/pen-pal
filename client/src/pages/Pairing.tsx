import { useEffect, useState } from 'react';
import { usePairing } from '../stores/pairing';
import { CheckIcon, InboxIcon, UnlinkIcon, XIcon } from '../components/Icons';

export default function Pairing() {
  const { incoming, outgoing, partner, myPid, loading, error, refresh, request, accept, reject, unpair } =
    usePairing();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

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
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <InboxIcon /> Invite — Pairing
      </h1>
      <p className="muted">My PID: {myPid ?? (loading ? '…' : 'unknown')}</p>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input
          aria-label="Target PID"
          placeholder="TARGET PID"
          value={target}
          onChange={(e) => setTarget(e.target.value.toUpperCase())}
          style={{ textTransform: 'uppercase' }}
        />
        <button
          className="primary"
          disabled={busy || !target.trim()}
          onClick={() => void run(() => request(target.trim()), 'Invite sent').then(() => setTarget(''))}
        >
          Send invite
        </button>
      </div>

      <h2>Incoming ({incoming.length})</h2>
      {incoming.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span>
            {r.username} ({r.pid})
          </span>
          <button disabled={busy} onClick={() => void run(() => accept(r.id), 'Accepted')} aria-label={`Accept ${r.username}`}>
            <CheckIcon size={16} />
          </button>
          <button disabled={busy} onClick={() => void run(() => reject(r.id), 'Rejected')} aria-label={`Reject ${r.username}`}>
            <XIcon size={16} />
          </button>
        </div>
      ))}
      {incoming.length === 0 && <p className="muted">No incoming invites.</p>}

      <h2>Outgoing ({outgoing.length})</h2>
      {outgoing.map((o) => (
        <p key={o.id} className="muted">
          {o.target_pid} — {o.status}
        </p>
      ))}

      <h2>Partner</h2>
      {partner ? (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span>
            {partner.friendly_name ?? partner.username} ({partner.pid})
          </span>
          <button disabled={busy} onClick={() => void run(() => unpair(), 'Unpaired')} aria-label="Unpair">
            <UnlinkIcon size={16} />
          </button>
        </div>
      ) : (
        <p className="muted">Not paired.</p>
      )}

      {(error || msg) && <p className="muted">{error || msg}</p>}
    </div>
  );
}
