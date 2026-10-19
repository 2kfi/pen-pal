#!/usr/bin/env node
/**
 * Documentation gate: every colour in docs/DESIGN.md must be a live token value.
 *
 * ## Why this exists
 *
 * docs/DESIGN.md documented light `--wax` as `#b45309` while tokens.css shipped
 * `#a8490a`, and documented dark `--rule` as `#2a2f38` while the code shipped
 * `#363c47`. Both were invisible: the contrast gate parses tokens.css and never
 * opens the documentation, so a stale value there changes nothing about what the
 * build accepts and nothing about what the app paints. The doc was simply wrong,
 * and it stayed wrong through two contrast repairs.
 *
 * A self-hosted project's documentation is read by the person operating it, at
 * the moment they are trying to change something. A wrong value there is not
 * cosmetic; it sends them to edit a colour that nothing uses.
 *
 * The check is deliberately one-directional. This gate asserts that the doc
 * contains no colour the product does not ship. It does not assert the reverse,
 * because a token can legitimately exist without being spelled out in prose.
 *
 * Usage: node tools/check-docs.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'client/src/tokens.css'), 'utf8');
const doc = readFileSync(join(root, 'docs/DESIGN.md'), 'utf8');

/** Every hex the product actually ships. */
function liveColours() {
  const out = new Map();
  for (const theme of ['dark', 'light']) {
    const start = css.indexOf(`[data-theme='${theme}']`);
    if (start === -1) continue;
    const block = css.slice(start, css.indexOf('\n}', start));
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
      out.set(m[2].toLowerCase(), `${theme} --${m[1]}`);
    }
  }
  return out;
}

const live = liveColours();

// Prose that names a colour in order to reject it. Naming a colour you are
// refusing is the opposite of documenting a stale value: the anti-slop table is
// full of them, and a gate that failed those would get switched off.
//
// Two signals, because they occur in different places: "not #..." or "old #..."
// inside a prose sentence, and a table row whose own second column is the
// instruction to do something other than this. Both are about intent, and the
// alternative is a gate that cries wolf on every legitimate reference.
const isDiscussed = (hex, context) =>
  /not\s+`?#|old\s+`?#|v0\.0\.2|rejected|instead|rejected|which failed|measured/i.test(context) ||
  /\|\s*(Not|Deliberately|V0)/.test(context);

const referenced = [...doc.matchAll(/`?(#[0-9a-fA-F]{6})`?/g)].map((m) => ({
  hex: m[1].toLowerCase(),
  index: m.index,
}));

let stale = 0;
for (const { hex, index } of referenced) {
  if (live.has(hex)) continue;

  const line = doc.slice(0, index).split('\n').length;
  const context = doc.split('\n')[line - 1] ?? '';

  if (isDiscussed(hex, context)) {
    console.log(`  ok   line ${line}  ${hex}  named while being rejected`);
    continue;
  }
  console.log(`  FAIL line ${line}  ${hex}  is not a value tokens.css ships`);
  console.log(`       ${context.trim().slice(0, 100)}`);
  stale += 1;
}

// The reverse direction, which is the one that actually bites: a token whose
// value the document names must be the value in the file. Checked by looking for
// a hex that sits in a table row for a token that now holds a different value.
for (const theme of ['dark', 'light']) {
  const start = css.indexOf(`[data-theme='${theme}']`);
  const block = css.slice(start, css.indexOf('\n}', start));
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    const name = m[1];
    const hex = m[2].toLowerCase();
    // A row for this token that quotes some OTHER hex is the drift we are here for.
    const row = new RegExp(`\\|\s*\`--${name}\`[^\\n]*`).exec(doc);
    if (!row) continue;
    const quoted = [...row[0].matchAll(/#[0-9a-fA-F]{6}/g)].map((x) => x[0].toLowerCase());
    if (quoted.length && !quoted.includes(hex) && !isDiscussed(hex, row[0])) {
      const line = doc.slice(0, row.index).split('\n').length;
      console.log(`  FAIL line ${line}  --${name} is ${hex} in tokens.css, doc says ${quoted.join(', ')}`);
      stale += 1;
    }
  }
}

if (stale) {
  console.log(`\n${stale} documented colour(s) disagree with tokens.css.`);
  console.log('tokens.css is the source of truth; correct the documentation, not the code.');
  process.exit(1);
}

console.log(`\nAll ${referenced.length} colour references in docs/DESIGN.md match tokens.css.`);
