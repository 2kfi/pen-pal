# PenPal V2 — Progress

> Single source of truth for where the rebuild is. Updated as work lands.
> Branch: `v2`. `v0.0.2` is tagged and archived (it could not be logged into).

---

## The product thesis

**Two people, one sealed channel, slow on purpose.**

PenPal is a self-hosted, end-to-end encrypted correspondence app. You pair with
exactly one person and exchange letters that cannot be edited after sending and
cannot be opened early. The interface follows a postal metaphor: paper, wax,
postmark, ink.

Every feature is judged against one question: *does this make two people keep
writing to each other?*

---

## What those numbers mean

The counts below are **plan steps** out of 30, tracked in
`~/.opencode/plan/penpal-v2.md`. One step is a discrete, verifiable piece of
work — not a task, not a commit.

| Status | Count | Meaning |
|---|---|---|
| **Done** | 27 | Implemented and verified |
| **Partial** | 3 | Shipped, but the step as written is not complete |
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

### Phase 1 — Product reset (2/4)

| Step | | Note |
|---|---|---|
| 7 | ✅ | Thesis written into `docs/DESIGN.md` |
| 8 | ✅ | Jellyfin cut entirely — server routes, module, page, two stores, MiniPlayer |
| 9 | 🔶 | `pairs` rekeyed on `user_id`, so one-partner is a storage guarantee. **Letter lifecycle states (`draft → sealed → in_transit → opened → replied`) do not exist** |
| 10 | ❌ | No SSE, no IndexedDB queue, no optimistic writes |

### Phase 2 — Design remake (6/7)

| Step | | Note |
|---|---|---|
| 11 | ✅ | Token system in `client/src/tokens.css` |
| 12 | ✅ | Light accent failed AA at 4.45:1 → fixed at source to `#a8490a`. Split `--rule` / `--rule-strong`. **CI gate: `npm run design:check`, 22 pairs** |
| 13 | ✅ | Mobile-first with a bottom tab bar (v0.0.2 shipped zero media queries) |
| 14 | ✅ | Landmarks, skip link, real labels, `:focus-visible` (there were none), 44px targets, `aria-live` |
| 15 | ✅ | Paper/wax/postmark. Spine layout recovered from the deleted legacy CSS |
| 16 | ✅ | The seal-and-send moment: 700ms fold → wax press → travel, exactly per DESIGN §6. Fails closed with a 2500ms liveness guard |
| 17 | ❌ | No `/style` gallery, so the design system can rot silently |

### Phase 3 — Make it a real app (2/6)

| Step | | Note |
|---|---|---|
| 18 | ❌ | `server/index.js` is still one ~500-line file |
| 19 | 🔶 | Uploads are auth-gated, magic-byte sniffed, re-encoded through sharp, EXIF verified gone. **No pair check — any authenticated user with a URL can fetch** |
| 20 | ❌ | **JWT still in `localStorage`. One XSS = full account loss.** Highest-value security item remaining |
| 21 | ✅ | sharp/libvips pipeline, 9 tests verified to fail against the old code |
| 22 | 🔶 | `/healthz` + compose healthcheck exist. No migration runner, no scheduled backups, no error tracking |
| 23 | ✅ | Chess perft, crypto round-trips, 70 API tests, Playwright E2E wired into CI |

### Phase 4 — Fix the games (2/5)

| Step | | Note |
|---|---|---|
| 24 | ✅ | Full rules engine. **perft: startpos exact to depth 4 (197281), Positions 3/4/5 exact** |
| 25 | ❌ | No search engine at all |
| 26 | ❌ | Two-player chess is local-only |
| 27 | ❌ | No rituals — daily puzzle, streaks, anniversary |
| 28 | ✅ | Promotion picker, drag **and** click, last-move highlight, captured pieces, move list, coordinates, sound off by default |

### Phase 5 — Ship it (1/2)

| Step | | Note |
|---|---|---|
| 29 | ✅ | Least-privilege tokens, concurrency groups, E2E gating the image build, deploy with health check **and rollback**, CodeQL, Dependabot |
| 30 | 🔶 | README, `SELF-HOSTING.md`, `DESIGN.md`, `HANDOFF.md` written. **No migration path for v0.0.2 databases, no `SECURITY.md`** |

---

## Known defects (not on the plan)

These surfaced during the work and are tracked here so they don't get lost.

| | |
|---|---|
| **Photos unencrypted at rest** | Letter bodies are encrypted. **Attachments are not** — they sit behind an authenticated route, not cryptography. Stated in README, SELF-HOSTING and HANDOFF |
| **Kiwipete perft short** | Depth 2 is 1 node short, depth 3 is 51 short. Not root-caused. Asserted in the test name so it stays visible |
| **Not installable** | No manifest, no service worker, no offline. A URL in a browser |
| **Rate limiter keyed on proxy IP** | `trust proxy` was never set, so behind Caddy/nginx one person could lock out their pen pal. Fixed |

---

## Verification gates

Every one of these must stay green.

```bash
npm run design:check                      # 22 contrast pairs
npm run lint
npm test                                  # 70 API tests
npm --prefix client test                  # 44 crypto + perft
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