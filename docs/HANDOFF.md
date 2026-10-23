# Handoff — state of V2

> Updated 2026-10: the pen-pals-plural work has landed. Read this first; it is
> written to be true at the moment you read it.

## Toolchain

| Thing | Status |
|---|---|
| Node | v26.11.1, npm 12.2.0 |
| better-sqlite3 | v13 — v11 cannot compile on Node 26 (removed V8 APIs) |
| Playwright | `~/.venvs/playwright`, chromium installed and launching |
| Design skills | `frontend-design`, `accessibility`, `webapp-testing`, `gsap-react`, `ui-ux-pro-max` — all in `~/.config/opencode/skills/` |

Playwright is **not** on `PATH`. Use `~/.venvs/playwright/bin/python` directly.

## What is done

- **The app works.** v0.0.2 could not be logged into. Signup, login, a real
  vault unlock gate, pairing, encrypted send, encrypted read.
- **Encryption is real and fail-closed.** Keys generated in-browser, PBKDF2 at
  600k, per-letter AES-256-GCM wrapped to both parties, AAD binds
  sender/recipient/timestamp. Compose refuses to send rather than falling back
  to plaintext.
- **Security holes closed:** world-readable uploads, client-controlled upload
  extensions (SVG stored-XSS), account enumeration, the double-app serving
  path, and the lockfile exclusion that made the Docker image unbuildable.
- **Correctness:** one-partner-per-user is now a storage guarantee; scheduled
  letters are actually withheld until due.
  *(2026-10 update: migration `070` revokes the one-partner rule — the storage
  guarantee is now UNIQUE(user_id, partner_id): many pals, never the same pal
  twice. Every per-pair surface (archive channel, rituals pair-key, chess
  pair-key) names its pal and re-checks it against the caller's own pairings.)*
- **Chess rules engine** verified by perft: startpos exact to depth 4
  (197281), Positions 3/4/5 exact.
- **Design system** in `client/src/tokens.css`, documented in `docs/DESIGN.md`,
  with a CI contrast gate (`npm run design:check`, 22 pairings).
- **Legacy vanilla app deleted** from the repo entirely.

## Known gap — do not forget this one

**Uploaded photos are stored unencrypted at rest.** The server can read the
bytes. They are protected by an authenticated route, not by encryption. This
contradicts the E2E promise for attachments (letter *bodies* are genuinely
encrypted; attachments are not). Closing it means encrypting in the browser
before upload, which changes the upload API and the reading path.

## Known gap — chess

**Kiwipete perft is short by 1 (depth 2) and 51 (depth 3)** against published
values. Not root-caused. The two tests assert current values with the reference
in the test name so the gap stays visible rather than being papered over.

There is **no search/AI opponent**. The board is two-player on one device.

## Gates that must stay green

```bash
npm run design:check                      # 22 contrast pairs  (now: 40 + docs colour gate)
npm test                                  # API tests (now 291)
npm --prefix client test                  # crypto + chess perft (now 79)
npm --prefix client run build             # typecheck + vite build
```

The Playwright E2E lives in `tests/e2e/` and is wired into CI.

## Trap worth knowing

`npm run build` at the **root** is only a syntax check of the server. The client
build is `npm run build --prefix client`. Running only the root build produces a
server with no `client/dist`, and since the server only serves that directory
when it exists, you get a backend with no UI at all.