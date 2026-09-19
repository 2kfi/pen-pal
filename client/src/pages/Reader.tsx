import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLetters } from '../stores/letters';
import { EnvelopeIcon } from '../components/Icons';

// Reader renders user data as text only — never innerHTML (legacy app.js XSS fix).
export default function Reader() {
  const { id } = useParams();
  const { fetchMore, byId } = useLetters();
  const letter = byId(Number(id));

  useEffect(() => {
    if (!letter) void fetchMore(50);
  }, [letter, fetchMore]);

  if (!letter) {
    return (
      <div className="card">
        <p className="muted">Letter not found in local cache.</p>
        <Link to="/letters">Back</Link>
      </div>
    );
  }

  return (
    <article className="card reader">
      <p className="muted">
        #{letter.id} · sent {letter.sent_at}
        {letter.delivered_at ? ` · delivers ${letter.delivered_at}` : ''}
      </p>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <EnvelopeIcon /> Letter #{letter.id}
      </h1>
      <p>{readableBody(letter.encrypted_content)}</p>
      {letter.photo_paths && <p className="muted">Photos: {letter.photo_paths}</p>}
      <Link to="/letters">Back to stream</Link>
    </article>
  );
}

function readableBody(content: string): string {
  try {
    const o = JSON.parse(content) as { content?: string };
    if (typeof o.content === 'string') return '(encrypted — unlock with your private key)';
  } catch {
    // plain text
  }
  return content;
}
