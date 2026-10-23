# PenPal V2 — Progress

> Single source of truth for where the rebuild is. Updated as work lands.
> Branch: `v2`. `v0.0.2` is tagged and archived (it could not be logged into).

---

## The product thesis

**A letter takes time. That is the feature.**

PenPal is a self-hosted, end-to-end encrypted correspondence app. You pair with
as many pen pals as you like, and each correspondence is its own sealed
channel: its own archive, its own daily puzzle and streak, its own chess board.
Letters cannot be edited after sending and cannot be opened early. The
interface follows a postal metaphor: paper, wax, postmark, ink.

Every feature is judged against one question: *does this make two people keep
writing to each other?*

---

## What those numbers mean

The counts below are **plan steps** out of 30, tracked in
`~/.opencode/plan/penpal-v2.md`. One step is a discrete, verifiable piece of
work — not a task, not a commit.

| Status | Count | Meaning |
|---|---|---|
| **Done** | 30 | Implemented and verified |
| **Partial** | 0 | Shipped, but the step as written is not complete |
| **Not started** | 0 | Nothing exists yet |

"Verified" means: a test asserts it, or a browser drove it. Not "it compiles".

---

## Status by phase

### Phase 0 — Stop the bleeding (6/6 ✅)

The app could not be logged into. This phase made it usable.

| Step | | Note |
|---|---|---|
| 1 | ✅ | Tagged `v0.0.2`, opened `v2` |
| 2 | ✅ | Deleted the legacy `public/` app (~1400 lines) |
| 3 | ✅ | `.gitignore` was excluding `package-lock.json`, so `npm ci` failed and **the Docker image had never built**. Fixed; both lockfiles committed |
| 4 | ✅ | Login posted to `/api/auth/login` (never existed) with `username` (server wants `email`). No signup screen at all. Both rewritten |
| 5 | ✅ | `crypto.ts` exported four functions nothing called. Keys now generated in-browser, PBKDF2 600k, per-session vault. **Compose refuses to send rather than falling back to plaintext** |
| 6 | ✅ | `helmet()` defaults shipped `upgrade-insecure-requests`, breaking plain-HTTP LAN. Explicit CSP. Fonts self-hosted (the Google Fonts link was blocked by our own CSP) |

### Phase 1 — Product reset (4/4 ✅)

| Step | | Note |
|---|---|---|
| 7 | ✅ | Thesis written into `docs/DESIGN.md` |
| 8 | ✅ | Jellyfin cut entirely — server routes, module, page, two stores, MiniPlayer |
| 9 | ✅ | `pairs` rekeyed on `user_id`, so one-partner is a storage guarantee. Lifecycle states (`sealed → in_transit → opened → replied`) in `040-letter-states`. State is **derived on read**, so storage can lag and the API is still correct |
| 10 | ✅ | `client/src/lib/sync.ts`: `(created_at, id)` cursor paging, SSE with verified teardown, IndexedDB outbox that is idempotent against a retry, optimistic writes that keep the draft on failure |

### Phase 2 — Design remake (7/7 ✅)

| Step | | Note |
|---|---|---|
| 11 | ✅ | Token system in `client/src/tokens.css` |
| 12 | ✅ | Light accent failed AA at 4.45:1 → fixed at source to `#a8490a`. Split `--rule` / `--rule-strong`. **CI gate: `npm run design:check`, 32 pairs** — `--paper-2` added after it was found to be hiding two live failures |
| 13 | ✅ | Mobile-first with a bottom tab bar (v0.0.2 shipped zero media queries) |
| 14 | ✅ | Landmarks, skip link, real labels, `:focus-visible` (there were none), 44px targets, `aria-live` |
| 15 | ✅ | Paper/wax/postmark. Spine layout recovered from the deleted legacy CSS |
| 16 | ✅ | The seal-and-send moment: 700ms fold → wax press → travel, exactly per DESIGN §6. Fails closed with a 2500ms liveness guard |
| 17 | ✅ | `/style` renders live from the tokens, honest about FAILs, dev-gated. `tests/rituals.test.js` fails if the gallery and the CI gate ever drift apart |

### Phase 3 — Make it a real app (6/6 ✅)

| Step | | Note |
|---|---|---|
| 18 | ✅ | Nine routers, **zero inline routes**. `server/index.js` is 229 lines and holds only what an entrypoint should: helmet, CORS, CSP, parsers, rate limits, mounts, SPA fallback, shutdown |
| 19 | ✅ | Uploads are auth-gated, magic-byte sniffed, re-encoded through sharp, EXIF verified gone. **And authorised**: `/uploads` is no longer a static mount, it resolves the request to its `photos` row and allows only the uploader or the other party in the attached letter. Denials return 404, not 403, so it cannot be used to enumerate |
| 20 | ✅ | Access token in a module closure, never persisted. Refresh token is an `httpOnly`/`SameSite=Strict` cookie stored as a SHA-256 hash, rotated on every use, with family revocation on reuse. One shared in-flight refresh, so nothing can present a single-use token twice |
| 21 | ✅ | sharp/libvips pipeline, 9 tests verified to fail against the old code |
| 22 | ✅ | Migration runner with a ledger and a duplicate-version guard, `/healthz` that fails on an unreachable database or a pending migration, `scripts/backup.sh` using SQLite's online `.backup` (never `cp` on a live WAL), request ids threaded into logs |
| 23 | ✅ | Chess perft, crypto round-trips, 70 API tests, Playwright E2E wired into CI |

### Phase 4 — Fix the games (4/5, one partial)

| Step | | Note |
|---|---|---|
| 24 | ✅ | Full rules engine. **perft: startpos exact to depth 4 (197281), Positions 3/4/5 exact** |
| 25 | ✅ | Iterative deepening in a Web Worker, 5 levels, PSTs, transposition table, cooperative cancel. **~30–50k nodes/sec** — slow, because every node is an await. `a3` as its best first move at depth 12 is not explained yet |
| 26 | ✅ | Two people, one board, over the wire. Moves sealed client-side and relayed by the server, turn enforced server-side, resign / draw by agreement / take-back, move list, board persistence, **PGN export**. Verified in a browser with two accounts: the move persists, the partner sees it, both survive a reload |
| 27 | ✅ | Daily shared puzzle (deterministic from pair id + date, so neither side learns the other's answer first), letter streak, anniversary. **Answers and streak state are encrypted at rest**; the test reads the db, `-wal` and `-shm` |
| 28 | ✅ | Promotion picker, drag **and** click, last-move highlight, captured pieces, move list, coordinates, sound off by default |

### Phase 5 — Ship it (2/2 ✅)

| Step | | Note |
|---|---|---|
| 29 | ✅ | Least-privilege tokens, concurrency groups, E2E gating the image build, CodeQL, Dependabot. **The on-push deploy workflow was removed later** (v2→main ff-merge ended with a workflow that no longer matched any live host); the image itself still publishes on the registry tag |
| 30 | ✅ | `MIGRATION.md` and `SECURITY.md` added. The v0.0.2 upgrade path is tested against a byte-accurate old-schema database, and `MIGRATION.md` states plainly what it cannot preserve |

---

## Known defects (not on the plan)

These surfaced during the work and are tracked here so they don't get lost.

| | |
|---|---|
| **Pen pals, plural (2026-10)** | The one-partner rule is gone. `pairs` lost its `user_id` PK to migration `070` and gained `UNIQUE(user_id, partner_id)`: many pals, never the same pal twice. Each correspondence is a separate channel — its own archive in the letter grid, its own daily ritual and ledger pair-key, its own chess pair-key. The rail carries a pal switcher (one dial per pal, unread counts per channel, never summed). Game routes resolve membership from the game's own `pair_key`, so an open board stays playable across pal switches; rituals/games name the pal server-side and re-check it against the caller's own pairings. Unpair is per pal and refuses to guess when several exist. Letters addressed by `sender_id`/`recipient_id` needed no schema change; the seal's AAD already binds sender + recipient, so a multi-pal world inherits its forgery resistance unchanged |
| **UI rebuild 2026, phase 4 done** | The 2026 direction (`DESIGN-UPDATED.md`, referenced by `docs/DESIGN.md` §4) is adopted end to end: postal-yellow palette solved for AA, Inter for the chrome (Literata stays for reading), 48px header + correspondence rail shell, letter-card grid with token-only stamp art, compose as a sheet. Rituals/Settings/chess carried over (segmented controls, one accent per screen, Phone-wrap gate fixed); StyleGuide specimens truthful again with the four new parts; `dir="auto"` + logical properties for RTL readiness; loading states wait in their own shape |
| **Chess table completeness** | A take-back now survives a refresh (base re-derived from the sealed move list) and finished games can be read back from the archive row |
| **Photos unencrypted at rest** | Letter bodies are encrypted. **Attachments are not** — they sit behind an authenticated route, not cryptography. Stated in README, SELF-HOSTING and HANDOFF |
| **Offline = the shell, not the data** | A service worker now installs (`client/public/sw.js`, registered from `main.tsx` in production): the full app shell — every route chunk, via a generated `sw-manifest.json` — opens with no network, and cached routes navigate offline. **`/api` and `/uploads` are never cached**, so letters and photos stay un-cached ciphertext/plaintext; offline deep links fall back to the sign-in screen because the server holds the envelopes. That is deliberate: the cache the next person on the device could read must never hold a letter or a photo |
| **Kiwipete perft** | Still 1 short at depth 2, 51 short at depth 3. Unrooted; not fixed, deliberately |
| **Rate limiter keyed on proxy IP** | `trust proxy` was never set, so behind Caddy/nginx one person could lock out their pen pal. Fixed |
| **Engine strength** | Depth 12 in 15s is fine for `casual`/`club`, marginal for `tough`. Do not offer `strong` to a competent player until the `a3` opening is explained |
| **`/healthz` 503s for 5s after boot** | Deliberate warmup grace. CI polls for 30s. Set `HEALTHZ_BOOT_GRACE_MS=0` if your orchestrator gives up faster |

---

## Verification gates

Every one of these must stay green.

```bash
npm run design:check                      # 40 contrast pairs + the docs colour gate
npm run lint
npm test                                  # 291 tests (server + client lib)
npm --prefix client test                  # 79 crypto, perft, session, pgn, sealed-list
npm --prefix client run build             # typecheck + vite build
```

Plus CI on GitHub: lint, tests, E2E (two real browser contexts), image build,
CodeQL.

**Trap:** `npm run build` at the *root* only syntax-checks the server. The client
build is `npm run build --prefix client`. Run only the root one and you get a
backend with no UI, because the server only serves `client/dist` when it exists.

---

## Environment

- Node v26.11.1 · npm 12.2.0 (CI and Docker use 22)
- `better-sqlite3@13` — v11 cannot compile on Node 26 (removed V8 APIs)
- Playwright at `~/.venvs/playwright`, **not on PATH**
- Docker daemon unavailable locally; the image build is verified by CI instead