# Handoff — where V2 actually is

> Written 2026-10-13 when work paused mid-Phase-0. Read this first.

## Toolchain (verified working)

| Thing | Status |
|---|---|
| Node | v26.11.1, npm 12.2.0 — installed via `pacman -S nodejs npm` |
| Playwright | `~/.venvs/playwright`, chromium installed, launches OK |
| Design skills | `frontend-design`, `accessibility`, `webapp-testing`, `gsap-react` in `~/.config/opencode/skills/` |

Playwright is **not** on PATH. Use `~/.venvs/playwright/bin/python` for any
script written against the `webapp-testing` skill.

---

## Done

- **Diagnosis + 30-step plan** → `~/.opencode/plan/penpal-v2.md`
- **Design plan** → `docs/DESIGN.md` (thesis, type scale, colour tokens, spine
  layout, motion rules, a11y floor, responsive, cut list)
- **`.gitignore`** — stopped ignoring `package-lock.json`. This was the reason the
  Docker image could never build (`npm ci` with no lockfile).
- **`.dockerignore`** — keeps `node_modules`/`data`/`uploads` out of the image.
- **`server/index.js`**
  - Removed `express.static('public')`. Previously `/` served the legacy vanilla
    app and `/letters` served React — two apps, one origin. Now exactly one.
  - Replaced `helmet()` defaults with an explicit CSP. The old default shipped
    `upgrade-insecure-requests` (breaks plain-HTTP LAN, the normal deployment)
    and blocked all externally-hosted images.
  - Upload filename no longer trusts `path.extname(originalname)` — that was the
    stored-XSS hole. Extension now comes from a server-side allowlist.
  - SVG excluded from uploads entirely.

---

## Not done yet — the honest list

**Blocked / needs a step from you**
- `client/package-lock.json` still missing → Docker build still fails.
  Fix: `npm --prefix client install` then commit it.
- No commit has been made. Everything above is uncommitted working-tree changes.
- `v2` branch not created, `v0.0.2` not tagged yet (plan step 1).

**Not started**
- Plan steps 4–6: auth screens, encryption vault, font self-hosting.
- Everything in Phases 1–5.

**Known-broken, still broken**
- `Login.tsx` POSTs `/api/auth/login` (route does not exist) with `username`
  (server wants `email`). **The app cannot be logged into.**
- There is still no signup screen.
- Encryption still silently falls back to plaintext on failure.

---

## Resume from here

```bash
npm --prefix client install          # generates client/package-lock.json
git checkout -b v2 && git add -A    # step 1
npm install && npm test              # baseline before touching auth
```

Then plan step 4: real `/signup` + `/login` against `/api/login`, generating the
keypair during signup. Verify the whole flow with the `webapp-testing` skill
before moving on — steps 1–3 exist so that this flow is provable.