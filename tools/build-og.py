#!/usr/bin/env python
"""
Render PenPal's social card.

## Why the browser, and not sharp

The card contains the wordmark, set in Syne, which is a woff2. librsvg (inside
sharp) will not load a woff2, so passing `font-family="Syne"` renders silently
and produces a card set in DejaVu Sans: it looks plausible in a thumbnail while
advertising the wrong typeface. That is precisely what the design direction
forbids, and it is the kind of failure a byte-count check will never notice.

Chromium loads the same woff2 with no trouble, so the card is rendered here
instead. The verification at the bottom measures the rendered widths of the
wordmark in the real family and in the fallback and fails if they match, which
is what turns "it rendered" into "it rendered correctly".

The mark itself is not drawn here. tools/build-brand.mjs owns the geometry and
emits favicon.svg; this script embeds that file, so the card and the tab icon
cannot drift into two different seals.

Usage:
    ~/.venvs/playwright/bin/python tools/build-og.py
"""

import base64
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "client/public"

TAGLINE = "A letter takes time. That is the feature."
DESCRIPTION = "SELF-HOSTED / END-TO-END ENCRYPTED / TWO PEOPLE"


def data_uri(path: pathlib.Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def token(name: str, theme: str = "dark") -> str:
    """Read a colour out of tokens.css rather than restating it.

    A brand asset that hardcodes its own palette will advertise a colour the
    product stopped using, and nothing will catch it.
    """
    css = (ROOT / "client/src/tokens.css").read_text()
    start = css.index(f"[data-theme='{theme}']")
    block = css[start : css.index("\n}", start)]
    for line in block.splitlines():
        line = line.strip()
        if line.startswith(f"--{name}:"):
            return line.split(":", 1)[1].strip().rstrip(";")
    raise SystemExit(f"--{name} not found in theme {theme}")


def main() -> int:
    wax = token("wax")
    ink = token("ink")
    paper = token("paper", "light")

    disc = data_uri(PUBLIC / "favicon.svg", "image/svg+xml")
    syne = data_uri(PUBLIC / "fonts/syne-800-0000-00ff.woff2", "font/woff2")
    mono = data_uri(PUBLIC / "fonts/space-mono-400-0000-00ff.woff2", "font/woff2")

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face {{ font-family: Syne; src: url({syne}) format('woff2'); font-weight: 800; }}
  @font-face {{ font-family: SpaceMono; src: url({mono}) format('woff2'); }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ width: 1200px; height: 630px; background: {ink}; overflow: hidden; }}
  .card {{ width: 1200px; height: 630px; padding: 118px 92px; display: flex;
           flex-direction: column; }}
  .mark {{ width: 132px; height: 132px; margin-bottom: 54px; }}
  .mark img {{ width: 100%; height: 100%; display: block; }}
  h1 {{ font-family: Syne; font-weight: 800; font-size: 84px; line-height: 1;
        color: {paper}; letter-spacing: -0.02em; }}
  p.tag {{ font-family: Syne; font-weight: 700; font-size: 33px; line-height: 1.3;
           color: {paper}; opacity: 0.78; margin-top: 22px; }}
  .rule {{ width: 104px; height: 3px; background: {wax}; margin-top: 34px; }}
  p.meta {{ font-family: SpaceMono; font-size: 20px; color: {paper}; opacity: 0.46;
            margin-top: 30px; letter-spacing: 0.08em; }}
</style></head>
<body><div class="card">
  <div class="mark"><img src="{disc}" alt=""></div>
  <h1>PenPal</h1>
  <p class="tag">{TAGLINE}</p>
  <div class="rule"></div>
  <p class="meta">{DESCRIPTION}</p>
</div>
<script>
  // Measured, not asserted. If the woff2 failed to load, the wordmark would
  // silently render in the fallback and the card would still look fine in a
  // thumbnail. Comparing the two widths is what catches that.
  window.__probe = () => {{
    const mk = (fam) => {{
      const el = document.createElement('span');
      el.textContent = 'PenPal';
      el.style.cssText = 'position:absolute;visibility:hidden;font-size:82px;font-weight:800;white-space:nowrap;font-family:' + fam;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return Math.round(w);
    }};
    return {{ syne: mk('Syne'), fallback: mk('sans-serif') }};
  }};
</script>
</body></html>"""

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630})
        page.set_content(html)
        page.wait_for_timeout(500)

        probe = page.evaluate("window.__probe()")
        if probe["syne"] == probe["fallback"]:
            browser.close()
            print(
                f"  FAIL: Syne did not load (both render at {probe['syne']}px). "
                "The card would be set in the fallback typeface.",
                file=sys.stderr,
            )
            return 1

        out = PUBLIC / "og-image.png"
        page.screenshot(path=str(out))
        browser.close()

    print(f"  og-image.png           {out.stat().st_size:>7} bytes")
    print(f"  wordmark verified as Syne: {probe['syne']}px, the fallback would be {probe['fallback']}px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
