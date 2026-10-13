import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Renders a decrypted letter.
 *
 * Letter bodies are attacker-controlled text arriving over the network, so the
 * marked() output MUST be sanitised before it reaches innerHTML. DOMPurify is
 * configured with an explicit allowlist rather than relying on its defaults,
 * because "no images, no links" is a design decision here, not an oversight —
 * a letter is prose, and remote content in a private letter is a tracking vector.
 */
// Typed off the library itself rather than importing `DOMPurify.Config` from a
// separate @types package — dompurify v3 ships its own types and the stub package
// disagrees with them.
type PurifyConfig = NonNullable<Parameters<typeof DOMPurify.sanitize>[1]>;

const PURIFY_CONFIG: PurifyConfig = {
  ALLOWED_TAGS: [
    'p', 'br', 'em', 'strong', 'del', 'blockquote', 'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'hr', 'a', 'span',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  // No data-* attributes: prevents DOM clobbering via injected elements.
  ALLOW_DATA_ATTR: false,
};

export function renderLetterBody(markdown: string): string {
  const parsed = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(parsed, PURIFY_CONFIG) as unknown as string;
}

/**
 * A one-line preview for the archive list. Deliberately NOT markdown — it is
 * plain text inside a React node, so there is no injection surface at all.
 */
export function previewText(markdown: string, max = 140): string {
  const flat = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}