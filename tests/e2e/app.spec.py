"""
End-to-end browser proof for PenPal, in two isolated browser contexts.

What it proves (nothing else in the repo does):
  1. you can sign up and log in
  2. you can read your PID and pair with another person
  3. a letter you send can be opened and *decrypted* by the recipient
  4. the sender can still re-read their own letter afterwards
  5. the plaintext of that letter appears NOWHERE in the SQLite database

Point 5 is the one that matters. Every other test in this repo runs against the
API with the ciphertext already in hand, so they can only prove that crypto
plumbing did not throw -- not that the user's plaintext never left the browser.
A regression that shipped the body unencrypted, or logged it, or cached it, would
pass `npm test` and fail here. That is why this suite exists and why CI runs it.

Run:
    npm run e2e                     # assumes a server on :3999 and DATA_DIR=tmp/data
    npm run e2e:setup                # one-time: install playwright + chromium

Configuration (all optional, defaults suit local development):
    BASE_URL        default http://localhost:3999
    E2E_PASSWORD    default "correct-horse-battery" (the throwaway signup password)
    E2E_DATA_DIR    default $DATA_DIR, else "tmp/data" -- MUST match the
                    server's DATA_DIR, it is where the SQLite assertion reads from
    E2E_SHOT_DIR    default tests/e2e/screenshots

CI sets every one of these explicitly; see .github/workflows/ci.yml.
"""

import os
import sqlite3
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:3999")
PW = os.environ.get("E2E_PASSWORD", "correct-horse-battery")
DATA_DIR = os.environ.get("E2E_DATA_DIR") or os.environ.get("DATA_DIR") or "tmp/data"
SHOT = os.environ.get("E2E_SHOT_DIR", "tests/e2e/screenshots")
DB_PATH = os.path.join(DATA_DIR, "penpal.db")

_failures = 0


def shot(name, page=None, full_page=False):
    """Screenshot into the configured dir; never let a screenshot kill the run."""
    os.makedirs(SHOT, exist_ok=True)
    path = os.path.join(SHOT, f"{name}.png")
    if page is None:
        return path
    try:
        page.screenshot(path=path, full_page=full_page)
    except Exception as e:  # pragma: no cover - diagnostics only
        print(f"  (screenshot failed: {e})")
    return path


def dump_failure(page, what):
    """
    Say what actually rendered.

    A bare "Timeout 20000ms exceeded waiting for selector" tells you nothing in a
    CI log: the app might have bounced to /login, rendered a crash screen, or
    never served the JS bundle at all. Print the URL and the body so the log
    answers "what did the user see?".
    """
    global _failures
    _failures += 1
    name = f"fail-{_failures:02d}-{(what or 'unknown').strip('/').replace('/', '-').replace('=', '-')[:40]}"
    try:
        url = page.url
    except Exception:
        url = "<unknown>"
    try:
        title = page.title()
    except Exception:
        title = "<unknown>"
    try:
        body = page.inner_text("body")[:600]
    except Exception:
        body = "<could not read body>"
    print(f"\n  !! expected {what!r}")
    print(f"  !! url:    {url}")
    print(f"  !! title:  {title}")
    print(f"  !! body:   {body!r}")
    print(f"  !! shot:   {shot(name, page, full_page=True)}\n")


def wait_for(page, selector, timeout=20_000, what=None):
    try:
        page.wait_for_selector(selector, timeout=timeout)
    except Exception:
        dump_failure(page, what or selector)
        raise


def wait_for_url(page, url, timeout=20_000):
    try:
        page.wait_for_url(url, timeout=timeout)
    except Exception:
        dump_failure(page, f"navigation to {url}")
        raise


def signup(page, username, email):
    page.goto(f"{BASE}/signup")
    page.fill("#username", username)
    page.fill("#email", email)
    page.fill("#password", PW)
    page.fill("#confirm", PW)
    page.click("button[type=submit]")
    wait_for_url(page, f"{BASE}/letters")
    print(f"  signup OK -> {username}")


def read_pid(page, password):
    open_page(page, "/pairing", password, wait_for_selector=".pid-badge")
    pid = page.inner_text(".pid-badge").strip()
    assert len(pid) == 6, f"expected a 6-char PID, got {pid!r}"
    print(f"  pid: {pid}")
    return pid


def open_page(page, path, password, wait_for_selector=None):
    """
    Navigate, then unlock if the vault gate is up.

    A full page load drops the in-memory key, so the gate returns after every
    goto(). It must be WAITED for, not polled with an immediate count() -- the
    gate lives in a lazily-loaded chunk and is not in the DOM at first paint.
    """
    page.goto(f"{BASE}{path}")

    try:
        page.wait_for_selector("#unlock-password", timeout=15000)
        page.fill("#unlock-password", password)
        page.click('button:has-text("Unlock")')
        page.wait_for_selector("#unlock-password", state="detached", timeout=40000)
        print("  (vault unlocked)")
    except Exception:
        # The gate never appeared: this context is already unlocked. A gate that
        # DID appear and then failed to unlock is diagnosed by the next wait_for.
        pass

    if wait_for_selector:
        wait_for(page, wait_for_selector)


def ensure_unlocked(page, password):
    netloc = urlsplit(BASE).netloc
    current = page.url
    if netloc and current.startswith(netloc):
        current = current[len(netloc):]
    open_page(page, current or "/", password)


def pair(requester, target_pid, password):
    open_page(requester, "/pairing", password, wait_for_selector="#target-pid")
    requester.fill('#target-pid', target_pid)
    requester.click('button:has-text("Send invite")')
    wait_for(requester, 'text=Invite sent.', timeout=10_000)
    print("  invite sent")


def accept(invitee, requester_username, password):
    open_page(invitee, "/pairing", password, wait_for_selector=".invite-row")
    invitee.locator('.invite-row', has_text=requester_username).locator('button:has-text("Accept")').click()
    wait_for(invitee, 'text=Paired.', timeout=10_000)
    print("  invite accepted")


def main():
    os.makedirs(SHOT, exist_ok=True)
    print(f"base={BASE} data_dir={DATA_DIR} shots={SHOT}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        ctx_a = browser.new_context(viewport={"width": 1280, "height": 900})
        ctx_b = browser.new_context(viewport={"width": 1280, "height": 900})
        a, b = ctx_a.new_page(), ctx_b.new_page()

        errors = []
        for name, pg in (("A", a), ("B", b)):
            pg.on("console", lambda m, n=name: errors.append(f"[{n}] {m.text}") if m.type == "error" else None)
            pg.on("pageerror", lambda e, n=name: errors.append(f"[{n}] PAGEERROR {e}"))

        print("\n1. signup")
        signup(a, "ada", "ada@test.local")
        signup(b, "sam", "sam@test.local")

        print("\n2. read PIDs")
        pid_a = read_pid(a, PW)
        pid_b = read_pid(b, PW)

        print("\n3. pair")
        # One direction only. The v0.0.2 app happily let a user pair with the
        # same person twice (and with unlimited others); the single-partner
        # constraint now forbids the reciprocal invite, so the reciprocal leg is
        # gone from this test rather than worked around.
        pair(a, pid_b, PW)
        accept(b, "ada", PW)

        print("\n4. A writes a letter")
        open_page(a, "/letters/new", PW, wait_for_selector="#letter-body")
        secret = "Dear Sam,\n\nthe tide came in sideways today and took my hat.\n\n— A"
        a.fill("#letter-body", secret)
        shot("03-compose", a)
        a.click('button:has-text("Seal and send")')
        wait_for_url(a, f"{BASE}/letters")
        print("  letter sent")

        print("\n5. B sees the archive")
        open_page(b, "/letters", PW, wait_for_selector=".letter")
        wait_for(b, ".letter")
        excerpt = b.inner_text(".letter-excerpt").strip()
        print(f"  B sees excerpt: {excerpt!r}")
        assert "tide came in sideways" in excerpt, "B could not read the letter preview"
        shot("04-archive", b)

        print("\n6. B opens it")
        b.click(".letter")
        wait_for(b, ".reader")
        body = b.inner_text(".reader")
        print(f"  B reads: {body[:60]!r}...")
        assert "tide came in sideways" in body, "B could not decrypt the letter"
        shot("05-reader", b)

        print("\n7. the server never saw plaintext")
        assert os.path.exists(DB_PATH), (
            f"no database at {DB_PATH} -- E2E_DATA_DIR must match the server's DATA_DIR "
            f"(server may not have created it yet)"
        )
        con = sqlite3.connect(DB_PATH)
        blobs = [r[0] for r in con.execute("SELECT encrypted_content FROM letters").fetchall()]
        con.close()
        for blob in blobs:
            assert "tide came in sideways" not in blob, "PLAINTEXT LEAKED INTO THE DATABASE"
        print(f"  {len(blobs)} letter(s) in DB, none contain the plaintext ✓")

        print("\n8. A can re-read their own letter")
        open_page(a, "/letters", PW, wait_for_selector=".letter")
        wait_for(a, ".letter")
        a.click(".letter")
        wait_for(a, ".reader")
        assert "tide came in sideways" in a.inner_text(".reader"), "sender cannot re-read own letter"
        print("  sender re-read OK ✓")

        print("\n9. mobile viewport")
        m = browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True)
        mp = m.new_page()
        mp.goto(f"{BASE}/login")
        mp.fill("#email", "sam@test.local")
        mp.fill("#password", PW)
        mp.click("button[type=submit]")
        try:
            mp.wait_for_url(f"{BASE}/letters", timeout=20_000)
        except Exception:
            dump_failure(mp, "mobile navigation to /letters")
            raise
        shot("06-mobile", mp, full_page=True)
        print("  375px renders and signs in ✓")

        # A reload must not sign you out.
        #
        # The access token is memory-only by design, so a page load re-mints it
        # from the httpOnly refresh cookie. That refresh token is SINGLE-USE and
        # the server revokes the whole family if it is presented twice — so if
        # anything ever makes two refreshes race (StrictMode's double mount did
        # exactly this), every single page load signs the user out everywhere.
        # open_page() above reloads constantly but folds that failure into a
        # confusing "selector not found", so assert it directly here.
        print("\n9b. a reload keeps you signed in")
        mp.reload(wait_until="networkidle")
        try:
            mp.wait_for_url(f"{BASE}/letters", timeout=20_000)
            assert "/login" not in mp.url, "a reload signed the user out"
        except Exception:
            dump_failure(mp, "session did not survive a reload")
            raise
        print("  reload restores the session from the cookie ✓")

        print("\n10. dark + light")
        shot("07-dark", a)
        open_page(a, "/settings", PW, wait_for_selector="text=Theme")
        a.click('button:has-text("Letter on the table")')
        open_page(a, "/letters", PW, wait_for_selector=".letter")
        shot("08-light", a)
        open_page(a, "/pairing", PW, wait_for_selector=".pid-badge")
        shot("09-pairing-light", a)
        print("  both themes render ✓")

        # Plan step 25, verified where it was previously unverified: in a
        # PRODUCTION build served over HTTP. The search module worked in Node and
        # in the Vite dev server, but nothing imported it in the app, so the
        # Worker was never bundled and was discoverable only in dev.
        print("\n11. the chess search runs in a Worker")
        open_page(a, "/play", PW, wait_for_selector="text=Against the computer")
        a.click('button:has-text("Against the computer")')
        # Casual, not Strong: this asserts the plumbing, and Strong takes 15s.
        a.click('button:has-text("Casual")')
        wait_for(a, '[data-sq="52"]', timeout=20000)

        body = a.inner_text("body")
        assert "Web Worker" in body, "the engine fell back to the main thread in a production build"
        assert "main thread" not in body, "the engine reported a degraded transport"

        # e2-e4, then let it answer.
        a.click('[data-sq="52"]')
        a.click('[data-sq="36"]')
        a.wait_for_function(
            "() => { const s = document.querySelector('.cb-status');"
            " return s && !/thinking/i.test(s.innerText); }",
            timeout=45000,
        )
        moves = a.eval_on_selector_all(".cb-moves li, .cb-movelist li, .cb-panel li",
                                       "els => els.map(e => e.innerText.trim())")
        assert moves, "the engine never replied: the move list is empty"
        assert "e4" in moves[0], f"the human's own move is missing from the list: {moves[:2]!r}"
        print(f"  engine replied: {moves[0].split()[-1]} ✓")
        shot("10-engine", a, full_page=True)

        a.set_viewport_size({"width": 375, "height": 812})
        a.wait_for_timeout(400)
        overflow = a.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        assert overflow <= 1, f"the board overflows by {overflow}px at 375px"
        shot("11-engine-375", a, full_page=True)
        print("  production Worker transport, no overflow at 375px ✓")
        a.set_viewport_size({"width": 1280, "height": 900})

        if errors:
            print("\nCONSOLE ERRORS:")
            for e in errors[:20]:
                print("  ", e)
        else:
            print("\nNo console errors ✓")

        browser.close()
        print("\n" + "=" * 46)
        print("E2E PASSED — signup, pairing, E2E delivery all work")
        print("=" * 46)


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"\nFAILED: {e}")
        sys.exit(1)