import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../lib/api';
import { encryptLetter } from '../lib/crypto';
import { usePairing } from '../stores/pairing';
import { EnvelopeIcon } from '../components/Icons';

const DRAFT_KEY = 'pp_draft';

export default function Compose() {
  const nav = useNavigate();
  const scope = useRef<HTMLDivElement>(null);
  const { partner, refresh } = usePairing();
  const [body, setBody] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [showPreview, setShowPreview] = useState(false);
  const [deliverAt, setDeliverAt] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, body);
  }, [body]);

  // ONE signature animation: initial state. useGSAP reverts (ctx.revert) on unmount.
  useGSAP(() => {
    gsap.set('.send-envelope', { x: 0, autoAlpha: 1 });
  }, { scope });

  const uploadFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const form = new FormData();
      form.append('photo', f);
      try {
        const r = await api<{ url: string }>('/api/photos/upload', { method: 'POST', body: form });
        setPhotos((p) => [...p, r.url]);
        setBody((b) => `${b}\n![photo](${r.url})`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Photo upload failed');
      }
    }
  };

  const animateSend = () =>
    new Promise<void>((resolve) => {
      const ctx = gsap.context(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gsap.to('.send-envelope', {
          x: reduced ? 0 : 120,
          autoAlpha: 0,
          duration: reduced ? 0.15 : 0.3,
          ease: 'power1.in',
          onComplete: () => {
            ctx.revert();
            resolve();
          },
        });
      }, scope);
    });

  const send = async () => {
    if (!partner) {
      setError('No partner paired yet — invite them first.');
      return;
    }
    setSending(true);
    setError('');
    try {
      await animateSend();
      let encryptedContent = body;
      try {
        const me = await api<{ publicKey?: string }>('/api/me');
        if (me.publicKey && partner.publicKey)
          encryptedContent = JSON.stringify(
            await encryptLetter(body, JSON.parse(partner.publicKey), JSON.parse(me.publicKey)),
          );
      } catch {
        // ponytail: keys missing/unparsable → send raw, server stores opaque blob
      }
      await api('/api/letters/send', {
        method: 'POST',
        body: JSON.stringify({
          recipientId: partner.id,
          encryptedContent,
          deliveredAt: deliverAt ? new Date(deliverAt).toISOString() : null,
        }),
      });
      localStorage.removeItem(DRAFT_KEY);
      nav('/letters');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
      setSending(false);
    }
  };

  const previewHtml = DOMPurify.sanitize(marked.parse(body || '*Nothing yet*') as string);

  return (
    <div className="card" ref={scope}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span className="send-envelope" style={{ display: 'inline-flex' }}>
          <EnvelopeIcon />
        </span>
        Compose
      </h1>
      <div className="compose-grid">
        <textarea
          aria-label="Letter markdown"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Dear pen pal… (markdown)"
          rows={12}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void uploadFiles(e.dataTransfer.files);
          }}
          className={dragOver ? 'drop-active' : undefined}
        />
        <div>
          <button onClick={() => setShowPreview((s) => !s)}>
            {showPreview ? 'Hide preview' : 'Preview'}
          </button>
          {showPreview && (
            <article className="reader" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <label className="muted">
          Deliver at <input type="date" value={deliverAt} onChange={(e) => setDeliverAt(e.target.value)} />
        </label>
        <label className="muted">
          Attach photo
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
            }}
          />
        </label>
        <button className="primary" onClick={() => void send()} disabled={sending || !body.trim()}>
          {sending ? 'Sending…' : 'Send letter'}
        </button>
      </div>
      {photos.length > 0 && <p className="muted">{photos.length} photo(s) attached</p>}
      {error && <p className="muted">{error}</p>}
    </div>
  );
}
