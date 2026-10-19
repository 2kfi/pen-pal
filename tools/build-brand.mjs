#!/usr/bin/env node
/**
 * Build PenPal's brand assets from one shape.
 *
 * ## Why a generated script rather than checked-in binaries
 *
 * Every mark here is the same disc at a different size, and the values it uses
 * are the tokens already in client/src/tokens.css. Generating them means the
 * wax colour can never drift from the accent the app actually paints with, which
 * is the same reasoning as the contrast gate: a value nobody checks is a value
 * that rots. Checked-in PNGs would be checked by nobody.
 *
 * ## The reduction
 *
 * A wax seal is not legible at 16px. Its impression is a circle with an
 * irregular, slightly ragged rim, and that raggedness is the first thing to
 * disappear under rasterisation, leaving a smudge. So the icon is the impression
 * reduced to what survives: a filled disc, a rim a shade darker than the fill,
 * and nothing inside it. No monogram, no crest, no lettering, because a letter
 * at 16px is either a blur or a guess.
 *
 * The rim is the whole trick. Without it the mark is a plain dot and reads as a
 * bullet. With it, it reads as something pressed.
 *
 * ## Usage
 *
 *   node tools/build-brand.mjs
 *
 * Writes into client/public/. Run it after changing a wax value in tokens.css.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'client/public');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Values, read from the tokens rather than restated. restating them here is how
// a brand asset ends up advertising a colour the product stopped using.
// ---------------------------------------------------------------------------

const tokens = readFileSync(join(root, 'client/src/tokens.css'), 'utf8');

function token(name, theme = 'dark') {
  const block = tokens.match(new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`theme "${theme}" not found in tokens.css`);
  const found = block[1].match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!found) throw new Error(`--${name} not found in theme "${theme}"`);
  return found[1];
}

const WAX = token('wax');
const WAX_BRIGHT = token('wax-bright');
const INK = token('ink');
const PAPER = token('paper', 'light');

/** Darken or lighten a hex colour by a fraction. Used only for the rim. */
function shade(hex, amount) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const to = (v) => Math.max(0, Math.min(255, Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  return `#${[to(r), to(g), to(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const RIM = shade(WAX, -0.28); // the pressed edge, in shadow

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/**
 * The edge of a pressed seal.
 *
 * Not a circle. A perfect circle with a ring inside it is a coin, a record or a
 * toggle, and none of those is a letter sealed with wax. Wax is squeezed out
 * under a die, so the edge is slightly uneven and slightly lobed, and that
 * unevenness is the only thing separating this mark from a coin at 16px.
 *
 * Radius varies by about 3% with a deterministic wave, so the shape is stable
 * across builds (no seeded randomness, no regenerated diff) while still reading
 * as pressed rather than drawn.
 */
function waxEdge(cx, cy, base, points = 96) {
  const pts = [];
  for (let i = 0; i < points; i += 1) {
    const theta = (i / points) * Math.PI * 2;
    const wobble =
      1 +
      0.018 * Math.sin(theta * 3 + 0.7) +
      0.012 * Math.sin(theta * 5 - 1.1) +
      0.007 * Math.sin(theta * 7 + 2.3);
    const r = base * wobble;
    pts.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
  }

  // Closed Catmull-Rom through the points, emitted as cubic beziers so it scales
  // without a polyline's corners.
  const f = (t) => (t % points + points) % points;
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < points; i += 1) {
    const p0 = pts[f(i - 1)];
    const p1 = pts[f(i)];
    const p2 = pts[f(i + 1)];
    const p3 = pts[f(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(2)} ${c1[1].toFixed(2)}, ${c2[0].toFixed(2)} ${c2[1].toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}

/**
 * One shape, described in a 64-unit box so every size below is a scale factor
 * rather than a separate drawing.
 *
 * The rim is a thicker inner copy of the same edge rather than a stroke. A
 * stroke's width does not survive rasterisation predictably at 16px, and the
 * browser is free to snap it away entirely, which is exactly what happened the
 * first time this was drawn as a stroke.
 */
function discSvg({ size = 64, background = null, rim = RIM, fill = WAX } = {}) {
  const cx = 32;
  const base = 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="PenPal">
  ${background ? `<rect width="64" height="64" fill="${background}"/>` : ''}
  <path d="${waxEdge(cx, cx, base)}" fill="${rim}"/>
  <path d="${waxEdge(cx, cx, base - 2.6)}" fill="${fill}"/>
</svg>`;
}

/** The mark with the light-theme wax, for the light browser chrome. */
// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const written = [];

async function emit(name, buffer) {
  writeFileSync(join(outDir, name), buffer);
  written.push([name, buffer.length]);
}

/** PNG at one size. */
async function png(name, svg, size) {
  await emit(name, await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer());
}

const svg = discSvg();

// The scalable icon, referenced first so a browser that understands SVG never
// touches a raster.
await emit('favicon.svg', Buffer.from(svg));

// Rasters for the browsers and contexts that still want them. 16 and 32 cover
// favicon slots; 180 is the iOS home-screen icon; 192 and 512 are what the
// manifest asks for.
await png('favicon-16x16.png', svg, 16);
await png('favicon-32x32.png', svg, 32);
await png('apple-touch-icon.png', discSvg({ background: INK }), 180);
await png('icon-192.png', svg, 192);
await png('icon-512.png', svg, 512);

// A maskable icon needs its art inside the safe zone, because the platform may
// crop it to whatever shape it likes. The same disc, inset further.
await png('icon-maskable-512.png', discSvg({ size: 64, background: INK }), 512);

// ICO, for the tab of anything that ignores the SVG. Built by hand because
// sharp does not write .ico and the format is a small header plus PNG frames.
function ico(pngBuffers) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngBuffers.length, 4);

  const entries = [];
  let offset = 6 + pngBuffers.length * 16;
  for (const { size, buffer } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width, 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += buffer.length;
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((f) => f.buffer)]);
}

const icoFrames = await Promise.all(
  [16, 32, 48].map(async (size) => ({
    size,
    buffer: await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer(),
  })),
);
await emit('favicon.ico', ico(icoFrames));

// ---------------------------------------------------------------------------
// Verify what came out rather than assuming.
// ---------------------------------------------------------------------------

for (const [name, bytes] of written) {
  console.log(`  ${name.padEnd(26)} ${String(bytes).padStart(7)} bytes`);
}
console.log(`\n  wax ${WAX} / rim ${RIM} / ink ${INK}`);
console.log('  the social card is tools/build-og.py: librsvg cannot load a woff2');
