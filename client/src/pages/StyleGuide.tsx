import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Navigate } from 'react-router-dom';
import Field from '../components/Field';
import { GLYPH } from '../lib/chessEngine';
import '../styleguide.css';

/**
 * /style — the design system, rendered from the tokens that ship (plan step 17).
 *
 * Every number on this page is read out of the live cascade with
 * `getComputedStyle` at run time. Nothing is transcribed, and nothing is a
 * screenshot. That is the entire point: a gallery of images proves the design
 * system existed on the day the pictures were taken, and a gallery built from
 * the real tokens is the only kind that notices when it starts to rot.
 *
 * The contrast section deliberately re-derives the WCAG maths instead of asking
 * the CI gate what it thinks. `npm run design:check` runs the same formula over
 * the same pairs in `tools/check-contrast.mjs`, so when the two ever disagree,
 * one of them is wrong and the page says so. A gallery that reported the gate's
 * verdict instead of computing its own would be a very expensive screenshot.
 *
 * It is dev-only. `import.meta.env.DEV` is replaced with `false` by the bundler,
 * so this component returns a redirect and the whole module is dropped from the
 * production bundle — a design-system playground is internal tooling, and
 * internal tooling shipped to production is how internal tooling turns into
 * somewhere to poke.
 */

/* ------------------------------------------------------------------ *
 * reading the tokens                                                  *
 * ------------------------------------------------------------------ */

type ThemeName = 'dark' | 'light';
const THEMES: ThemeName[] = ['dark', 'light'];

const COLOUR_TOKENS = [
  'ink',
  'paper',
  'paper-2',
  'rule',
  'rule-strong',
  'accent',
  'accent-hover',
  'accent-ink',
  'link',
  'link-hover',
  'in-transit',
  'danger',
  'success',
  'text',
  'text-secondary',
  'muted',
  'accent-wash',
  'transit-wash',
  'focus-ring',
] as const;

const SPACE_TOKENS = [
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-5',
  'space-6',
  'space-7',
] as const;

/**
 * The eleven pairs `tools/check-contrast.mjs` gates in CI, transcribed here in
 * the same shape and the same order as the gate's own `PAIRS`.
 *
 * `tests/rituals.test.js` parses both files and fails if these lists ever drift
 * apart, because a gallery that quietly stopped checking the same things
 * is the exact rot this page exists to prevent.
 */
const GATE_PAIRS: Array<[string, string, number, string]> = [
  ['text', 'ink', 4.5, 'body text on the page'],
  ['text', 'paper', 4.5, 'body text on a card'],
  ['text-secondary', 'ink', 4.5, 'secondary text on the page'],
  ['text-secondary', 'paper', 4.5, 'secondary text on a card'],
  ['muted', 'ink', 4.5, 'postmark metadata on the page'],
  ['muted', 'paper', 4.5, 'postmark metadata on a card'],
  ['accent-ink', 'accent', 4.5, 'text on the accent fill'],
  ['link', 'ink', 4.5, 'accent link on the page'],
  ['link', 'paper', 4.5, 'accent link on a card'],
  ['link-hover', 'ink', 4.5, 'hovered link on the page'],
  ['link-hover', 'paper', 4.5, 'hovered link on a card'],
  ['in-transit', 'ink', 4.5, 'transit label'],
  ['danger', 'ink', 4.5, 'error text'],
  ['rule-strong', 'paper', 3.0, 'interactive border on a card'],
  ['rule-strong', 'ink', 3.0, 'interactive border on the page'],
  ['focus-ring', 'ink', 3.0, 'focus indicator'],

  // --paper-2 is the lightest surface in the dark theme, so it is the worst case
  // for every foreground. Checking only --ink and --paper hid two live failures:
  // --muted at 4.4997:1 and --rule-strong at 2.76:1.
  ['muted', 'paper-2', 4.5, 'postmark metadata on a raised surface'],
  ['rule-strong', 'paper-2', 3.0, 'interactive border on a raised surface'],
  ['text', 'paper-2', 4.5, 'body text on a raised surface'],
  ['text-secondary', 'paper-2', 4.5, 'secondary text on a raised surface'],
  ['link', 'paper-2', 4.5, 'accent link on a raised surface'],
];

interface Usage {
  fg: string;
  bg: string;
  /** The wash composited over `bg`, if the real surface is a tint. */
  wash?: string;
  min: number;
  label: string;
  /** Where in the product this pairing actually occurs. */
  where: string;
}

/**
 * Pairings that occur in the product but are NOT in the gate list.
 *
 * Every one of these was found by reading the stylesheets for a token and
 * asking what it is actually painted on — not by inventing plausible ones. The
 * column that matters is `where`: a contrast check with no real usage behind it
 * is decoration, and decoration is how a gallery starts lying.
 */
const USAGES: Usage[] = [
  {
    fg: 'accent-ink',
    bg: 'accent',
    min: 4.5,
    label: 'label on the primary button',
    where: 'button.primary, a.button.primary — --accent is the fill, --accent-ink is the word on it',
  },
  {
    fg: 'accent-ink',
    bg: 'accent-hover',
    min: 4.5,
    label: 'primary button label, hovered',
    where: 'button.primary:hover — the 700ms moment spends most of its time in this state',
  },
  {
    fg: 'ink',
    bg: 'ink',
    wash: 'accent',
    min: 4.5,
    label: 'the active tab, on its own wash',
    where: '.topbar nav a.active — an accent wash over the page ground, --ink text',
  },
  {
    fg: 'link',
    bg: 'paper-2',
    min: 4.5,
    label: 'your pairing code',
    where: '.pid-badge — the six characters you read aloud to someone',
  },
  {
    fg: 'in-transit',
    bg: 'paper',
    min: 4.5,
    label: 'transit label inside a letter',
    where: '.letter.transit .letter-state — teal text on the letter itself, not on the page',
  },
  {
    fg: 'text',
    bg: 'paper-2',
    min: 4.5,
    label: 'what you have typed into a field',
    where: '.field input, .field textarea',
  },
  {
    fg: 'muted',
    bg: 'paper-2',
    min: 4.5,
    label: 'the date on a torn-off stub',
    where: '.rit-stub — the only vertical text in the product',
  },
  {
    fg: 'rule-strong',
    bg: 'paper-2',
    min: 3.0,
    label: 'the border of every input',
    where: '.field input, .field textarea — WCAG 2.2 SC 1.4.11, non-text contrast',
  },
  {
    fg: 'focus-ring',
    bg: 'paper-2',
    min: 3.0,
    label: 'focus ring drawn over a field well',
    where: ':focus-visible — the ring is drawn outside the input, so it lands on paper-2',
  },
  {
    fg: 'focus-ring',
    bg: 'ink',
    min: 3.0,
    label: 'focus ring drawn on the page ground',
    where: ':focus-visible on dark — the accent itself, not a separate colour',
  },
  {
    fg: 'text',
    bg: 'rule',
    min: 4.5,
    label: 'a piece on a dark square',
    where: '.cb-sq — --cb-dark-sq is --rule',
  },
];

/**
 * Tokens with no `var(--…)` reference anywhere in `client/src` outside
 * `tokens.css`. Re-verify with:
 *
 *   cd client/src && for t in transit-wash duration-slow duration-seal; do
 *     grep -ro -- "var(--$t)" . | wc -l; done
 *
 * Checked 14 Oct 2026. They are shown below as unused rather than omitted,
 * because a token nobody calls is either a rule that was dropped without anyone
 * noticing or a component that was never written, and both are worth seeing.
 */
const UNUSED = new Set(['transit-wash', 'duration-slow', 'duration-seal']);

const UNUSED_WHY: Record<string, string> = {
  'transit-wash':
    'Nothing paints a transit tint. Teal is reserved for the node on the spine (.letter.transit::before) and the label beside it, so the wash has no job.',
  'duration-slow':
    'The 450ms "letter opens" moment in DESIGN §6 is not implemented. Letters open with no animation at all.',
  'duration-seal':
    'SealAnimation.tsx hardcodes its timings in JavaScript (FOLD_MS, PRESS_MS, SEND_MS) instead of reading this token, so the 700ms the system declares and the 700ms the code runs are two unrelated numbers.',
};

/* ------------------------------------------------------------------ *
 * colour maths — identical to tools/check-contrast.mjs                *
 * ------------------------------------------------------------------ */

type RGB = [number, number, number];

const luminance = (rgb: RGB): number => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: RGB, b: RGB): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** `#rrggbb` or `rgb()/rgba()`. Returns null for anything it cannot read, so a
 *  token written in a future syntax shows as unreadable rather than as black. */
function parseColour(value: string): { rgb: RGB; alpha: number } | null {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return {
      rgb: [
        parseInt(hex[1].slice(0, 2), 16),
        parseInt(hex[1].slice(2, 4), 16),
        parseInt(hex[1].slice(4, 6), 16),
      ],
      alpha: 1,
    };
  }
  const fn = v.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 };
    }
  }
  return null;
}

/** Simple source-over. An 8% wash over a ground is what the eye actually sees. */
const over = (top: RGB, alpha: number, bottom: RGB): RGB =>
  top.map((c, i) => c * alpha + bottom[i] * (1 - alpha)) as RGB;

/* ------------------------------------------------------------------ *
 * reading the cascade                                                 *
 * ------------------------------------------------------------------ */

function readTokens(theme: ThemeName): Record<string, string> {
  const probe = document.createElement('div');
  probe.setAttribute('data-theme', theme);
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out: Record<string, string> = {};
  for (const t of [...COLOUR_TOKENS, ...SPACE_TOKENS]) out[t] = cs.getPropertyValue(`--${t}`).trim();
  out['--font-display'] = cs.getPropertyValue('--font-display').trim();
  out['--font-reading'] = cs.getPropertyValue('--font-reading').trim();
  out['--font-postmark'] = cs.getPropertyValue('--font-postmark').trim();
  for (const t of ['radius', 'radius-letter', 'radius-chip', 'target-min', 'duration-fast', 'duration-base', 'duration-slow', 'duration-seal', 'ease', 'measure', 'leading-reading', 'type-xs', 'type-sm', 'type-base', 'type-md', 'type-lg', 'type-xl', 'type-2xl']) {
    out[t] = cs.getPropertyValue(`--${t}`).trim();
  }
  probe.remove();
  return out;
}

/**
 * Resolves a token to a length in px, because `getPropertyValue('--space-3')`
 * hands back `0.75rem` and the reader wants to know how big that actually is.
 * Applied to a real property on a real element, so the browser does the maths.
 */
function resolvePx(token: string, property: 'width' | 'fontSize' | 'borderTopWidth'): string {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;';
  probe.style[property] = `var(--${token})`;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const value = property === 'fontSize' ? cs.fontSize : cs[property];
  probe.remove();
  return value;
}

/** px -> rem, so the number is the one written in tokens.css. */
function toRem(px: string): string {
  const n = Number.parseFloat(px);
  if (!Number.isFinite(n)) return px;
  return `${Number((n / 16).toFixed(4))}rem`;
}

/**
 * Formats a ratio so a failure can never be displayed as a pass.
 *
 * `--muted` on `--paper-2` in the dark theme measures 4.4997. Rounded to two
 * decimals that is "4.50", sitting immediately under a 4.5 requirement — a FAIL
 * badge reading PASS 4.50, which is worse than no badge at all because it
 * invites the reader to conclude the check has a rounding bug. So when the
 * rounded value and the verdict could be read as disagreeing, the number grows
 * precision until they cannot.
 */
function ratio(got: number, min: number, ok: boolean): string {
  const rounded = got.toFixed(2);
  const couldReadAsPass = Number(rounded) >= min;
  if (ok === couldReadAsPass) return rounded;
  return got.toFixed(4);
}

interface Failure {
  theme: ThemeName;
  label: string;
  got: number;
  need: number;
}

/** Theme -> token name -> the declared value, read from a real element. */
type TokenSet = Record<ThemeName, Record<string, string>>;

interface Gallery {
  tokens: TokenSet;
  checks: Array<{
    theme: ThemeName;
    fg: string;
    bg: string;
    label: string;
    where: string;
    min: number;
    got: number;
    ok: boolean;
    bgCss: string;
    fgCss: string;
  }>;
  failures: Failure[];
  gateCount: number;
}

function buildGallery(): Gallery {
  const tokens: TokenSet = { dark: readTokens('dark'), light: readTokens('light') };
  const checks: Gallery['checks'] = [];
  const failures: Failure[] = [];
  let gateCount = 0;

  const evaluate = (theme: ThemeName, u: { fg: string; bg: string; wash?: string; min: number; label: string; where: string; gated: boolean }) => {
    const t = tokens[theme];
    const fgRaw = t[u.fg];
    const bgRaw = t[u.bg];
    const fgC = parseColour(fgRaw);
    const bgC = parseColour(bgRaw);
    if (!fgC || !bgC) return;

    // A wash is composited over the surface it sits on, in the same order the
    // browser would: surface, then wash, then whatever text is painted over it.
    let surface = bgC.rgb;
    if (u.wash) {
      const washC = parseColour(t[u.wash]);
      if (!washC) return;
      surface = over(washC.rgb, washC.alpha, surface);
    }
    const fg = over(fgC.rgb, fgC.alpha, surface);

    const got = contrast(fg, surface);
    const ok = got >= u.min;
    if (u.gated) gateCount += 1;
    if (!ok) failures.push({ theme, label: u.label, got, need: u.min });

    const css = (c: RGB) => `rgb(${c.map((n) => Math.round(n)).join(' ')})`;
    checks.push({
      theme,
      fg: u.fg,
      bg: u.bg,
      label: u.label,
      where: u.where,
      min: u.min,
      got,
      ok,
      bgCss: css(surface),
      fgCss: css(fg),
    });
  };

  for (const theme of THEMES) {
    for (const [fg, bg, min, label] of GATE_PAIRS) {
      evaluate(theme, { fg, bg, min, label, where: 'gated in CI by tools/check-contrast.mjs', gated: true });
    }
    for (const u of USAGES) evaluate(theme, { ...u, gated: false });
  }

  return { tokens, checks, failures, gateCount };
}

/* ------------------------------------------------------------------ *
 * static description of each colour token                             *
 * ------------------------------------------------------------------ */

const TOKEN_NOTES: Record<string, string> = {
  ink: 'The page ground. Everything else is measured against it.',
  paper: 'A raised surface: a letter, a card.',
  'paper-2': 'An input well or the hover of a button. The brightest thing on the page.',
  rule: 'A decorative divider. Deliberately under 3:1 — it carries no information, and a hairline you can see from across the room is a rule shouting.',
  'rule-strong': 'The border of anything interactive. Clears 3:1 or the control is invisible.',
  accent: 'Postal yellow. A fill, never text: on the light page it would measure 1.50:1.',
  'accent-hover': 'Hover on the fill.',
  'accent-ink': 'The only colour allowed on yellow.',
  link: 'Accent-coloured text that is not text-on-yellow.',
  'link-hover': 'Hover on a link.',
  'in-transit': 'Teal means transit and nothing else, ever.',
  danger: 'Errors, and only errors.',
  success: 'Success feedback.',
  text: 'Body text.',
  'text-secondary': 'Descriptions, dates, supporting labels.',
  muted: 'The lowest permitted readable token. If a design needs something dimmer, the design is wrong.',
  'accent-wash': 'A 10% tint of yellow over the page, for the active tab.',
  'transit-wash': 'A 10% tint of teal. Nothing paints it.',
  'focus-ring': 'Drawn 2px at 2px offset, outside the control. Re-solved per theme.',
};

const TOKEN_SURFACES: Record<string, string> = {
  ink: 'carries --text at 4.5',
  paper: 'carries --text at 4.5',
  'paper-2': 'carries --text at 4.5, and a --rule-strong border at 3',
  rule: 'no contract',
  'rule-strong': '3:1 against --ink, --paper and --paper-2',
  accent: 'a fill, carries --accent-ink at 4.5',
  'accent-hover': 'a fill, carries --accent-ink at 4.5',
  'accent-ink': '4.5:1 on --accent and --accent-hover',
  link: '4.5:1 on --ink, --paper and --paper-2',
  'link-hover': '4.5:1 on --ink and --paper',
  'in-transit': '4.5:1 on --ink and --paper',
  danger: '4.5:1 on --ink',
  success: '4.5:1 on --ink and --paper',
  text: '4.5:1 on --ink, --paper and --paper-2',
  'text-secondary': '4.5:1 on --ink, --paper and --paper-2',
  muted: '4.5:1 on --ink, --paper and --paper-2',
  'accent-wash': 'decorative; it is a wash, not a surface',
  'transit-wash': 'unused',
  'focus-ring': '3:1 against --ink and --paper-2',
};

/* ------------------------------------------------------------------ *
 * the type scale                                                     *
 * ------------------------------------------------------------------ */

const TYPE_STEPS = [
  ['type-xs', 'postmark metadata'],
  ['type-sm', 'secondary text'],
  ['type-base', 'body text'],
  ['type-md', 'a question, an excerpt'],
  ['type-lg', 'a section heading'],
  ['type-xl', 'the page heading'],
  ['type-2xl', 'one number, on its own'],
] as const;

const FAMILIES: Array<{ token: string; name: string; rule: string; weights: string }> = [
  {
    token: 'font-display',
    name: 'Syne',
    rule: 'Headings and figures only. Never a paragraph.',
    weights: '700 headings, 800 for a number that is the point of the page',
  },
  {
    token: 'font-reading',
    name: 'Literata',
    rule: 'Anything a person reads rather than scans. Letters, questions, body.',
    weights: '400 body, 600 for a name inside a sentence',
  },
  {
    token: 'font-postmark',
    name: 'Space Mono',
    rule: 'Machine facts: dates, counts, statuses, codes. Uppercase and tracked.',
    weights: '400 labels, 700 for the one thing on screen that matters',
  },
];

const SAMPLE =
  'The wax seal on a letter you cannot edit and cannot open early.';

/* ------------------------------------------------------------------ *
 * parts                                                              *
 * ------------------------------------------------------------------ */

const LETTER_STATES: Array<{ key: string; state: string; desc: string }> = [
  {
    key: 'draft',
    state: 'draft',
    desc: 'Paper with live text on it. You can still read what you wrote, and change it.',
  },
  {
    key: 'sealed',
    state: 'sealed',
    desc: 'A closed envelope. The words are not rendered at all — there is nothing to read, so nothing is drawn.',
  },
  {
    key: 'transit',
    state: 'in transit',
    desc: 'Teal postmark, blurred words, and an arrival time. The letter exists and you cannot read it.',
  },
  {
    key: 'opened',
    state: 'opened',
    desc: 'The full letter in the reading serif, with the wax bottom-right where the seal was.',
  },
];

const BOARD_PIECES = [
  ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
  ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
] as const;

const BOARD_BACK = [
  ['', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', ''],
  ...BOARD_PIECES,
  ...BOARD_PIECES,
  ['', '', '', '', '', '', '', ''],
  ['', '', '♗', '', '♕', '', '♘', ''],
] as const;

/* ------------------------------------------------------------------ *
 * the page                                                            *
 * ------------------------------------------------------------------ */

export default function StyleGuide() {
  // Compile-time constant. In a production bundle this is `false`, the branch
  // below is dead, and the bundler drops the component entirely.
  if (!import.meta.env.DEV) return <Navigate to="/letters" replace />;
  return <Gallery />;
}

function Gallery() {
  const [g, setG] = useState<Gallery | null>(null);
  const [field, setField] = useState('');
  const [reduced, setReduced] = useState(false);
  const [theme, setTheme] = useState<ThemeName>('dark');

  useEffect(() => {
    // Two frames: one for React to attach, one for the stylesheet to be
    // settled. Reading a custom property before the first paint returns the
    // declared value rather than the used one on some engines.
    const id = window.setTimeout(() => setG(buildGallery()), 0);
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMq = () => setReduced(mq.matches);
    onMq();
    mq.addEventListener('change', onMq);
    return () => {
      window.clearTimeout(id);
      mq.removeEventListener('change', onMq);
    };
  }, []);

  const px = useMemo(() => {
    if (!g) return null;
    const out: Record<string, string> = {};
    for (const token of SPACE_TOKENS) out[token] = resolvePx(token, 'width');
    for (const [token] of TYPE_STEPS) out[token] = resolvePx(token, 'fontSize');
    return out;
  }, [g]);

  if (!g || !px) {
    return (
      <div className="sg">
        <p className="sg-note">Reading the tokens…</p>
      </div>
    );
  }

  const t = g.tokens[theme];
  const allPass = g.failures.length === 0;

  return (
    <div className="sg">
      {/* ---------------------------------------------------- verdict -- */}
      <header className="sg-head">
        <h1>The design system</h1>
        <p className="sg-lede">
          Everything below is read out of the stylesheet that ships, at the moment you loaded this
          page. No screenshots. If a token has drifted, this is where it shows.
        </p>

        <p className={`sg-verdict${allPass ? '' : ' is-fail'}`}>
          <span className="sg-verdict-word">{allPass ? 'All clear' : 'Failing'}</span>
          <span className="sg-verdict-count">
            {g.checks.length - g.failures.length} of {g.checks.length} contrast checks pass —{' '}
            {g.gateCount} of them the same ones CI gates.
          </span>
        </p>

        {g.failures.length > 0 && (
          <>
            <p className="sg-note">
              These are measured against the token&rsquo;s own contract and they do not meet it. The
              fix is in the token, not in this page.
            </p>
            <ul className="sg-failures">
              {g.failures.map((f) => (
                <li key={`${f.theme}-${f.label}`}>
                  <span className="sg-flag is-fail">FAIL</span>{' '}
                  <strong>{f.theme}</strong> — {f.label}: {ratio(f.got, f.need, false)}:1, needs {f.need}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="sg-gate">
          <strong>Development only.</strong> This route is not mounted in a production build and
          this component returns a redirect when <code>import.meta.env.DEV</code> is false. A design
          system is internal tooling; publishing it tells anyone reading it exactly which colours,
          durations and blind spots this product has.
        </p>
      </header>

      <nav className="sg-jump" aria-label="Sections">
        {[
          ['sg-colour', 'Colour'],
          ['sg-type', 'Type'],
          ['sg-space', 'Space'],
          ['sg-motion', 'Motion'],
          ['sg-parts', 'Parts'],
        ].map(([id, label]) => (
          <a href={`#${id}`} key={id}>
            {label}
          </a>
        ))}
      </nav>

      {/* ----------------------------------------------------- colour -- */}
      <section className="sg-section" id="sg-colour" aria-labelledby="sg-colour-h">
        <h2 id="sg-colour-h">Colour</h2>
        <p className="sg-subnote">
          Both themes, side by side, so they can be compared rather than remembered. Each swatch is
          the pairing itself: the background token with the foreground token&rsquo;s own letters on it,
          at the size the product uses. The ratio beside it is computed here, in this browser, from
          those two values — not read from the CI gate.
        </p>

        <div className="sg-row" role="group" aria-label="Which theme to read the raw values from">
          <span className="sg-family-name">Raw values from</span>
          <button type="button" onClick={() => setTheme('dark')} disabled={theme === 'dark'}>
            Dark
          </button>
          <button type="button" onClick={() => setTheme('light')} disabled={theme === 'light'}>
            Light
          </button>
        </div>

        {THEMES.map((name) => (
          <div className="sg-theme" data-theme={name} key={name}>
            <h4>{name === 'dark' ? 'Dark — the desk at night' : 'Light — the letter on the table'}</h4>

            <h5 className="sg-family-name" style={{ margin: 0 }}>
              Gated in CI
            </h5>
            {g.checks
              .filter((c) => c.theme === name && c.where.startsWith('gated'))
              .map((c) => (
                <Check key={`${name}-${c.fg}-${c.bg}-${c.label}`} c={c} sample={SAMPLE.slice(0, 28)} />
              ))}

            <h5 className="sg-family-name" style={{ margin: 'var(--space-4) 0 0' }}>
              Also in the product, not in CI
            </h5>
            {g.checks
              .filter((c) => c.theme === name && !c.where.startsWith('gated'))
              .map((c) => (
                <Check key={`${name}-${c.fg}-${c.bg}-${c.label}`} c={c} sample={SAMPLE.slice(0, 28)} />
              ))}
          </div>
        ))}

        <h3>Every colour token, read from {theme}</h3>
        <ul className="sg-tokens" data-theme={theme}>
          {COLOUR_TOKENS.map((name) => {
            const value = t[name];
            const unused = UNUSED.has(name);
            return (
              <li className={`sg-token${unused ? ' is-unused' : ''}`} key={name}>
                <span
                  className="sg-token-swatch"
                  style={{ ['--sg-value' as string]: value, ['--sg-on' as string]: value }}
                >
                  {/* The wash tokens are translucent, so the label is painted in
                      the wash itself over the page ground rather than over the
                      swatch — otherwise the swatch is 9% opacity and the hex
                      printed on it is unreadable, which is a specimen that
                      cannot be read. */}
                  <code>{value}</code>
                </span>
                <span className="sg-token-meta">
                  <span className="sg-token-name">--{name}</span>
                  <span className="sg-token-value">{value}</span>
                  <span className="sg-token-contract">{TOKEN_NOTES[name]}</span>
                  <span className="sg-token-contract">Contract: {TOKEN_SURFACES[name]}</span>
                  {unused && <span className="sg-token-contract">Unused. {UNUSED_WHY[name]}</span>}
                </span>
              </li>
            );
          })}
        </ul>

        <h3>Declared but never called</h3>
        <p className="sg-subnote">
          A token nothing references is either a rule that was quietly dropped or a component that
          was never written. Both are worth seeing, so they are listed rather than tidied away.
        </p>
        <ul className="sg-tokens" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))' }}>
          {[...UNUSED].map((name) => (
            <li className="sg-token is-unused" key={name} data-theme={theme}>
              <span className="sg-token-meta">
                <span className="sg-token-name">--{name}</span>
                <span className="sg-token-value">{t[name]}</span>
                <span className="sg-token-contract">{UNUSED_WHY[name]}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------- type -- */}
      <section className="sg-section" id="sg-type" aria-labelledby="sg-type-h">
        <h2 id="sg-type-h">Type</h2>
        <p className="sg-subnote">
          Three families, three jobs, two weights each. The sizes are a 1.200 minor third anchored at
          16px, and the px figures are resolved by the browser from the rem values in the token
          file, so they cannot be wrong about what is actually rendered.
        </p>

        {FAMILIES.map((f) => (
          <div className="sg-family" key={f.token}>
            <div className="sg-family-head">
              <span className="sg-family-name">{f.name}</span>
              <span className="sg-family-stack">--{f.token}</span>
              <span className="sg-family-rule">{f.rule}</span>
              <span className="sg-family-stack">{f.weights}</span>
            </div>

            {TYPE_STEPS.map(([token, job]) => (
              <div className="sg-type-row" key={`${f.token}-${token}`}>
                <span className="sg-type-key">
                  --{token}
                  <span>
                    {px[token]} · {toRem(px[token])}
                  </span>
                </span>
                <p
                  className="sg-type-sample"
                  style={{
                    fontFamily: `var(--${f.token})`,
                    fontSize: `var(--${token})`,
                    margin: 0,
                  }}
                >
                  <span className="sg-family-stack">{job} · </span>
                  {SAMPLE}
                </p>
              </div>
            ))}
          </div>
        ))}

        <div className="sg-family">
          <div className="sg-family-head">
            <span className="sg-family-name">Reading measure</span>
            <span className="sg-family-stack">--measure</span>
            <span className="sg-family-rule">
              A letter is capped at {t.measure}. Past that the eye loses the return sweep and you
              reread the line.
            </span>
          </div>
          <div className="sg-measure">
            <p style={{ maxWidth: t.measure, marginBottom: 'var(--space-2)' }}>{SAMPLE}</p>
            <div className="sg-measure-rule" style={{ maxWidth: t.measure }} />
            <p className="sg-family-stack" style={{ marginTop: 'var(--space-2)' }}>
              The rule above is the cap, drawn to scale.
            </p>
          </div>
          <p className="sg-subnote" style={{ marginTop: 'var(--space-3)' }}>
            Line height is --leading-reading, {t['leading-reading']}. Postmark lines are tight;
            reading lines are not.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------ space -- */}
      <section className="sg-section" id="sg-space" aria-labelledby="sg-space-h">
        <h2 id="sg-space-h">Space</h2>
        <p className="sg-subnote">
          Seven steps and no others. The bars are drawn at the resolved pixel width, so a step that
          was accidentally re-declared would be visibly the wrong size rather than plausibly the
          right one.
        </p>

        {SPACE_TOKENS.map((token) => (
          <div className="sg-scale-row" key={token}>
            <span className="sg-scale-key">--{token}</span>
            <span className="sg-scale-bar" style={{ ['--sg-size' as string]: px[token] }} />
            <span className="sg-scale-val">
              {px[token]} · {toRem(px[token])}
            </span>
          </div>
        ))}

        <h3>Radius</h3>
        <p className="sg-subnote">
          Three values, and nothing in between: a letter gets 2px, a chip gets a pill, everything
          else gets 3px. A fourth radius appearing here would mean a component grew one.
        </p>
        <div className="sg-radii">
          {(['radius-letter', 'radius', 'radius-chip'] as const).map((token) => (
            <div className="sg-radius-item" key={token}>
              <span
                className="sg-radius-box"
                style={{ ['--radius-pill' as string]: t[token], borderRadius: t[token] }}
                aria-hidden
              >
                ⬚
              </span>
              <span className="sg-scale-key">--{token}</span>
              <span className="sg-scale-val">{t[token]}</span>
            </div>
          ))}
        </div>

        <h3>Targets</h3>
        <p className="sg-subnote">
          WCAG 2.2 SC 2.5.8 asks for 44×44. The square below is that size against the real token, so
          &ldquo;does it fit&rdquo; is a question about the control and not about the stylesheet&rsquo;s
          intentions.
        </p>
        <span className="sg-target" aria-hidden>
          44
        </span>
      </section>

      {/* ----------------------------------------------------- motion -- */}
      <section className="sg-section" id="sg-motion" aria-labelledby="sg-motion-h">
        <h2 id="sg-motion-h">Motion</h2>
        <p className="sg-subnote">
          One orchestrated moment and everything else answering an action. The reduced column is
          what the tokens declare under <code>prefers-reduced-motion: reduce</code> — not a longer
          value, an absent one.
        </p>

        <p className="sg-row">
          <span className="sg-badge">
            Your system asks for reduced motion: {reduced ? 'yes' : 'no'}
          </span>
          {reduced && <span className="sg-badge is-on">These are live values right now</span>}
        </p>

        {(['duration-fast', 'duration-base', 'duration-slow', 'duration-seal'] as const).map((token) => (
          <div className="sg-motion-row" key={token}>
            <span className="sg-motion-what">
              <span className="sg-type-key">--{token}</span>
              <br />
              {MOTION_WHY[token]}
            </span>
            <span className="sg-num">{t[token]}</span>
            <span className={`sg-num${reduced ? '' : ' is-reduced'}`}>
              {REDUCED[token]}
              {reduced ? '' : ' declared'}
            </span>
            <span className="sg-scale-key">{UNUSED.has(token) ? 'not referenced anywhere' : 'ease: ' + t.ease}</span>
          </div>
        ))}

        <p className="sg-subnote" style={{ marginTop: 'var(--space-4)' }}>
          &ldquo;declared&rdquo; means the value the token file sets inside the media query. It only
          becomes the live value when the reader&rsquo;s system asks for reduced motion — which is
          what the badge above tells you.
        </p>
      </section>

      {/* ------------------------------------------------------ parts -- */}
      <section className="sg-section" id="sg-parts" aria-labelledby="sg-parts-h">
        <h2 id="sg-parts-h">Parts</h2>
        <p className="sg-subnote">
          Each specimen below is the real markup carrying the real class from the stylesheet that
          ships. The class is printed beside it, because the class is the thing that can rot.
        </p>

        <Part
          name="Button"
          cls="button"
          rule="Postmark type on a raised well. Every button in the product is at least 44px tall because --target-min is a floor, not a suggestion."
        >
          <div className="sg-row">
            <button type="button">Write a letter</button>
            <button type="button" className="sg-focus-demo">
              Focused
            </button>
            <button type="button" disabled>
              Not yet
            </button>
            <button type="button" className="sg-focus-demo" disabled>
              Not yet, focused
            </button>
          </div>
        </Part>

        <Part
          name="Primary button"
          cls="button.primary"
          rule="The only wax on the screen when it is present. If a seal is also on the page, the button steps back down to a postmark — see .compose.is-sealing."
        >
          <div className="sg-row">
            <button type="button" className="primary">
              Seal and send
            </button>
            <button type="button" className="primary" disabled>
              Sealing…
            </button>
            <a href="#sg-parts" className="button primary">
              As a link
            </a>
          </div>
        </Part>

        <Part
          name="Field"
          cls=".field"
          rule="Label, control, hint, error. The label is a real <label for>; the error is announced, not just coloured."
        >
          <div className="sg-row">
            <Field
              id="sg-demo-plain"
              label="Your answer"
              value={field}
              onChange={setField}
              hint="Numbers only. Sealed before it leaves this device."
            />
            <Field
              id="sg-demo-error"
              label="Pairing code"
              value="not a code"
              onChange={() => {}}
              error="Six letters. This one is shorter."
            />
          </div>
        </Part>

        <Part
          name="Chip"
          cls=".sg-chip (specimen)"
          rule="DESIGN §9 lists a status chip, and no such component existed in the stylesheet. This is the specimen for the one that should: pill radius, a word, and never colour alone. It is scoped to this page until it is needed by something other than a gallery."
        >
          <div className="sg-chip-row">
            <span className="sg-chip">draft</span>
            <span className="sg-chip">sealed</span>
            <span className="sg-chip is-transit">in transit</span>
            <span className="sg-chip">opened</span>
            <span className="sg-chip">replied</span>
            <span className="sg-chip is-wax">wax</span>
            <span className="sg-chip is-danger">could not be opened</span>
          </div>
        </Part>

        <Part
          name="Seal"
          cls=".seal, .seal-wax, .transit-mark"
          rule="The one memorable object in the product. A radial gradient in the same two wax tokens, never a third colour and never a flat fill."
        >
          <div className="sg-row">
            <span className="seal" aria-hidden />
            {/* At press size, which is the only size this wax is ever seen at
                outside the send moment. */}
            <span className="seal-wax sg-press-seal" aria-hidden />
            <span className="transit-mark" aria-hidden />
            <span className="sg-scale-key">sealed, on a letter</span>
            <span className="sg-scale-key">the wax itself, at press size</span>
            <span className="sg-scale-key">in transit</span>
          </div>
        </Part>

        <Part
          name="Letter, four states"
          cls=".letter, .letter.transit"
          rule="DESIGN §5. The four states differ by what they refuse to draw: a draft shows its words, a sealed letter does not, a travelling one blurs them, an opened one gives them up with the wax still on it."
        >
          <div className="sg-states">
            <div className="sg-spine" aria-hidden />
            {LETTER_STATES.map((s) => (
              <div className="sg-state" key={s.key}>
                <span className="sg-state-label">{s.state}</span>
                <div className={`letter${s.key === 'transit' ? ' transit' : ''}${s.key === 'opened' ? ' sg-letter-open' : ''}`}>
                  <div className="letter-state">
                    14 Mar{s.key === 'transit' ? ' · in transit' : ` · ${s.state}`}
                  </div>

                  {s.key === 'draft' && <p className="letter-excerpt">Still being written. You can read this back and change it.</p>}

                  {s.key === 'sealed' && (
                    <>
                      <div className="sg-envelope" aria-hidden>
                        <span className="seal-paper" />
                        <span className="seal-flap" />
                        <span className="seal-wax" />
                      </div>
                      <p className="letter-excerpt muted">Sealed. Nothing to read yet.</p>
                    </>
                  )}

                  {s.key === 'transit' && (
                    <>
                      <p className="letter-excerpt">
                        Whatever was written here is on its way and cannot be read by either of you until
                        it lands.
                      </p>
                      <p className="muted" style={{ marginTop: 'var(--space-2)' }}>
                        Arrives 19 Mar
                      </p>
                    </>
                  )}

                  {s.key === 'opened' && (
                    <>
                      <p className="letter-excerpt">
                        Dear Sam — the sea here is the colour of the envelope this came in, which I only
                        noticed after I had written four pages.
                      </p>
                      <span className="seal" aria-hidden />
                    </>
                  )}
                </div>
                <p className="sg-state-desc">{s.desc}</p>
              </div>
            ))}
          </div>
        </Part>

        <Part
          name="Spine"
          cls=".archive, .spine"
          rule="One hairline the height of the archive, with each letter a node on it. This is the idea that makes the product recognisable, and it was recovered from the deleted legacy stylesheet rather than invented."
        >
          <div className="sg-letters archive">
            <div className="spine" aria-hidden />
            <div className="letter">
              <div className="letter-state">2 Feb · opened</div>
              <p className="letter-excerpt">The first one. Two words and a drawing of a bird.</p>
            </div>
            <div className="letter transit">
              <div className="letter-state">2 Mar · in transit</div>
              <p className="letter-excerpt">Still travelling between here and there.</p>
            </div>
          </div>
        </Part>

        <Part
          name="Board"
          cls=".cb-board, .cb-sq, .cb-piece"
          rule="Eight by eight, sized to min(100%, 34rem) so it can never scroll sideways. Pieces are outline glyphs from the engine, not an icon font."
        >
          <div className="sg-board-demo">
            <div className="cb-board" role="img" aria-label="A chess board at the opening position">
              {BOARD_BACK.flat().map((piece, i) => {
                const rank = Math.floor(i / 8);
                const file = i % 8;
                const light = (rank + file) % 2 === 1;
                const classes = ['cb-sq', light ? 'cb-sq--light' : '', i === 19 ? 'cb-sq--selected' : '', i === 28 ? 'cb-sq--target' : '']
                  .filter(Boolean)
                  .join(' ');
                return (
                  <span className={classes} key={i}>
                    {file === 0 && (
                      <span className="cb-coord cb-coord--rank" aria-hidden>
                        {8 - rank}
                      </span>
                    )}
                    {rank === 7 && (
                      <span className="cb-coord cb-coord--file" aria-hidden>
                        {'abcdefgh'[file]}
                      </span>
                    )}
                    {piece && (
                      <span className={`cb-piece cb-piece--${rank < 4 ? 'w' : 'b'}`} aria-hidden>
                        {rank < 4 ? GLYPH.w[piece as 'p'] : GLYPH.b[piece as 'p']}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        </Part>
      </section>

      {/* ------------------------------------------------------- foot -- */}
      <footer className="sg-foot">
        <h2>What this page cannot tell you</h2>
        <p className="sg-subnote">
          A gallery that only shows what it can check will eventually be believed to check more than
          it does. So, honestly:
        </p>
        <ul>
          <li>
            It checks contrast on the page ground, on cards, and on input wells. It does not check
            contrast over photographs, and it cannot: a photo has no guaranteed darkest pixel.
          </li>
          <li>
            It cannot tell you whether a component is <em>used</em> anywhere. The unused-token list
            was produced by grepping <code>client/src</code> by hand, not computed.
          </li>
          <li>
            It renders the components, it does not operate them. Drag, keyboard paths, focus
            order and screen-reader announcements are verified by the E2E suite, not by a picture of
            a component.
          </li>
          <li>
            It shows the reduced-motion values the token file <em>declares</em>. Whether they are
            live depends on the reader&rsquo;s system, which the badge above reports honestly rather
            than pretending to simulate.
          </li>
          <li>
            <code>docs/DESIGN.md</code> §4 still lists the pre-fix light-theme values. The token file
            is the source of truth and this page reads the token file, so where the two disagree,
            this page is right and the document is stale.
          </li>
        </ul>
      </footer>
    </div>
  );
}

const MOTION_WHY: Record<string, string> = {
  'duration-fast': 'hover, tab colour, border tints',
  'duration-base': 'the settle on a reveal, link colour',
  'duration-slow': 'the letter opening. Not implemented.',
  'duration-seal': 'the fold, the press, the travel. Hardcoded in JS.',
};

/**
 * The values tokens.css declares inside `prefers-reduced-motion: reduce`.
 *
 * Transcribed rather than read, because a media query on `:root` cannot be
 * observed from a page that is not currently matching it — and the reduced
 * column is labelled as declared wherever it is not live. If these ever drift
 * from tokens.css, the drift is visible: the live column beside them will not
 * collapse to 0.01ms for a reader whose system asks for reduced motion.
 */
const REDUCED: Record<string, string> = {
  'duration-fast': '0.01ms',
  'duration-base': '0.01ms',
  'duration-slow': '0.01ms',
  'duration-seal': '0.01ms',
};

function Check({ c, sample }: { c: Gallery['checks'][number]; sample: string }) {
  const style: CSSProperties = {
    ['--sg-bg' as string]: c.bgCss,
    ['--sg-fg' as string]: c.fgCss,
  };
  return (
    <div className="sg-check">
      <span className="sg-check-spec" style={style}>
        <span>Aa</span>
        <span>{c.label}</span>
      </span>
      <span className={`sg-flag ${c.ok ? 'is-pass' : 'is-fail'}`}>
        {c.ok ? 'PASS' : 'FAIL'} {ratio(c.got, c.min, c.ok)}
      </span>
      <span className="sg-check-where">
        <code>
          --{c.fg} on --{c.bg}
        </code>{' '}
        · needs {c.min}:1 · {c.where} · {sample ? 'Aa ' : ''}
      </span>
    </div>
  );
}

function Part({
  name,
  cls,
  rule,
  children,
}: {
  name: string;
  cls: string;
  rule: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sg-part">
      <div className="sg-part-head">
        <span className="sg-part-name">{name}</span>
        <span className="sg-part-class">{cls}</span>
        <span className="sg-part-rule">{rule}</span>
      </div>
      {children}
    </div>
  );
}