import { useMemo, type ReactNode } from 'react';

/**
 * A stamp for a letter.
 *
 * DESIGN-UPDATED.md §5 puts a stamp illustration at the top-right of every
 * letter card, and §2 calls stamps "content, not decoration to be replaced
 * with generic icons" - which is an instruction we have to solve honestly given
 * the constraints this codebase actually keeps:
 *
 * 1. No remote art. The CSP is `img-src 'self'`; also, an E2E-encrypted letter
 *    does not phone a third party to fetch a thumbnail of itself.
 * 2. No raw hex outside tokens.css. The artwork cannot introduce a colour.
 * 3. No product rules invented. The reference's stamps carry denominations and
 *    country names; ours carry neither, because there is no stamp economy.
 *
 * So each letter gets its own sleeve, cut from tokens and seeded by the
 * letter's id: a perforated frame (the ink is --rule-strong, the perforation
 * circles knocked out in --paper so holes read as holes), and one of six
 * engraved motifs - valley, postmark sun, tide, mast, ridge, field - built
 * from the same three strokes a letter's own postmark uses. It is aria-hidden
 * decorative art; the footprint never changes with the letter's state.
 */
export default function StampArt({ seed, large = false }: { seed: number | string; large?: boolean }) {
  const motif = useMemo(() => MOTIFS[Math.abs(hash(String(seed))) % MOTIFS.length], [seed]);
  return (
    <svg
      className={`stamp ${large ? 'stamp-large' : ''}`}
      width={large ? 88 : 44}
      height={large ? 104 : 52}
      viewBox="0 0 44 52"
      aria-hidden="true"
      focusable="false"
    >
      {/* The perforated edge: small paper-coloured bites across the border. */}
      {PERFORATION.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="2.2" className="stamp-perf" />
      ))}
      <rect x="1" y="1" width="42" height="50" rx="1" className="stamp-border" />
      {motif}
    </svg>
  );
}

/** A tiny stable string hash: enough to spread motifs evenly, nothing more. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Bites uniformly around the 44x52 edge, avoiding the corners. */
const PERFORATION: Array<[number, number]> = [];
for (let x = 6; x < 44; x += 8) {
  PERFORATION.push([x, 0], [x, 52]);
}
for (let y = 6; y < 52; y += 8) {
  PERFORATION.push([0, y], [44, y]);
}

/* Six motifs, each a couple of strokes: engraved-postage shapes in the same
   --rule-strong ink everything structural uses. One per letter, spread out. */
const MOTIFS: ReactNode[] = [
  <g key="valley">
    <path d="M6 36 L16 24 L24 32 L30 26 L38 36" className="stamp-line" fill="none" />
    <circle cx="32" cy="14" r="4" className="stamp-line" fill="none" />
  </g>,
  <g key="sun">
    <circle cx="22" cy="22" r="7" className="stamp-line" fill="none" />
    <path d="M8 40 H36" className="stamp-line-h" />
  </g>,
  <g key="tide">
    <path d="M6 26 q5 -5 10 0 t10 0 t10 0" className="stamp-line" fill="none" />
    <path d="M6 34 q5 -5 10 0 t10 0 t10 0" className="stamp-line" fill="none" />
  </g>,
  <g key="mast">
    <path d="M22 10 V36" className="stamp-line" />
    <path d="M22 14 L34 26 H22" className="stamp-line" fill="none" />
    <path d="M12 38 H32" className="stamp-line-h" />
  </g>,
  <g key="ridge">
    <path d="M6 34 L14 20 L20 28 L27 16 L38 34" className="stamp-line" fill="none" />
  </g>,
  <g key="field">
    <path d="M10 34 H34 M10 28 H34 M10 22 H34" className="stamp-line-h2" />
    <path d="M8 38 H36" className="stamp-line-h" />
  </g>,
];
