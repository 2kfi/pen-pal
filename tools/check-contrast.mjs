#!/usr/bin/env node
/**
 * Contrast gate.
 *
 * docs/DESIGN.md §11 promises CI fails on a contrast regression. v0.0.2 shipped
 * an accent that failed AA and patched it by inventing a second accent token
 * used only for text; nothing checked either colour. This parses tokens.css and
 * fails the build if any required pair regresses.
 *
 * Usage: node tools/check-contrast.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'client/src/tokens.css'), 'utf8');

function theme(name) {
  const block = css.match(new RegExp(`\\[data-theme='${name}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`theme "${name}" not found in tokens.css`);
  const out = {};
  for (const m of block[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * `min` is the WCAG 2.2 requirement for that pairing:
 *   4.5 — body and secondary text (SC 1.4.3)
 *   3.0 — non-text UI components and focus indicators (SC 1.4.11)
 */
const PAIRS = [
  ['text', 'ink', 4.5, 'body text on the page'],
  ['text', 'paper', 4.5, 'body text on a card'],
  ['muted', 'ink', 4.5, 'postmark metadata on the page'],
  ['muted', 'paper', 4.5, 'postmark metadata on a card'],
  ['wax', 'ink', 4.5, 'accent link on the page'],
  ['wax', 'paper', 4.5, 'accent link on a card'],
  ['in-transit', 'ink', 4.5, 'transit label'],
  ['danger', 'ink', 4.5, 'error text'],
  ['rule-strong', 'paper', 3.0, 'interactive border on a card'],
  ['rule-strong', 'ink', 3.0, 'interactive border on the page'],
  ['focus-ring', 'ink', 3.0, 'focus indicator'],
];

let failures = 0;
for (const name of ['dark', 'light']) {
  const t = theme(name);
  console.log(`\n--- ${name} ---`);
  for (const [fg, bg, min, label] of PAIRS) {
    if (!t[fg] || !t[bg]) {
      console.log(`  ?  ${label}: missing --${fg} or --${bg}`);
      failures += 1;
      continue;
    }
    const ratio = contrast(t[fg], t[bg]);
    const ok = ratio >= min;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(32)} ${ratio.toFixed(2)}:1  (need ${min})`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} contrast check(s) failed. See docs/DESIGN.md §4.`);
  process.exit(1);
}
console.log('\nAll contrast checks passed.');