# PenPal Archive - Changelog & Project Log

## Project Overview
A private, end-to-end (E2E) encrypted letter-sharing application inspired by Slowly. Features media browsing (Jellyfin) and casual gaming (Chess).

---

## Version History

### v0.3.0 — V2 Phase 0: the app is finally usable (2026-10-13)

v0.0.2 shipped as "production-ready" while being unable to log in. Every item below
was verified end-to-end in a real browser, not just asserted in a unit test.

**Authentication — was completely broken**
- `Login.tsx` posted to `/api/auth/login`, which has never existed on the server,
  sending `username` where the server expects `email`. No one could ever sign in.
- There was no signup screen at all.
- Added `Signup` and a rewritten `Login`, plus an `Unlock` vault gate.

**Encryption — was theatre**
- `generateKeyPair`, `encryptPrivateKey`, `decryptPrivateKey` and `encryptLetter`
  were exported from `crypto.ts` and imported by nothing. The keypair was never
  generated, letters were never encrypted, and `Reader.tsx` hardcoded the string
  "(encrypted — unlock with your private key)".
- Keys are now generated in the browser during signup, wrapped with PBKDF2-SHA256
  at 600k iterations, and unlocked per session.
- **Compose no longer has a plaintext fallback.** v0.0.2 caught encryption
  failures and posted the raw body anyway. Failure now means the letter is not sent.
- Letter envelopes are versioned and bind sender, recipient and timestamp into the
  AES-GCM AAD, so a stored ciphertext cannot be re-addressed to a different
  recipient by an attacker with database write access.
- PBKDF2 iterations are recorded per key so the cost can be raised later.

**Security**
- Uploads were served world-readable at `/uploads/<uuid>`, publishing every photo
  in plaintext and quietly contradicting the E2E promise. Now authenticated.
- Upload filenames preserved the client's extension, so an uploaded `.svg` executed
  script on our own origin. Extensions now come from a server-side allowlist and
  SVG is rejected outright.
- Login returned "User not found" vs "Invalid password" — a free account-enumeration
  oracle. Both now return one indistinguishable 401.
- `helmet()`'s default CSP shipped `upgrade-insecure-requests`, which breaks plain-HTTP
  LAN deployments, and blocked every externally-hosted image. Replaced with an
  explicit policy.
- Fonts were linked from Google Fonts, which our own CSP blocked — so the typography
  silently fell back to system fonts in every real deployment. Now self-hosted
  (12 woff2 files, 465 KB, latin subset only).

**Correctness**
- A user could pair with unlimited people; the partner lookup used `.get()` on a
  multi-row query and returned an **arbitrary** partner, so letters could be
  delivered to the wrong person. `pairs` is now keyed on `user_id` (one row per
  user), making "one partner" a storage guarantee, and a second pairing returns 409.
- `delivered_at` was stored but never filtered on, so "Deliver no earlier than"
  was decorative and scheduled mail arrived immediately. The recipient now sees
  nothing until the letter is due; the sender sees it in transit.

**Build — the image never built**
- `.gitignore` excluded `package-lock.json`, and `client/package-lock.json` was
  never committed, so `npm ci` in the Dockerfile failed immediately. Both lockfiles
  are now committed.
- Added `.dockerignore`; `node_modules`, `data/` and `uploads/` no longer leak into
  the image.
- `better-sqlite3@11` cannot compile against Node 26 (`v8::Object::GetPrototype`,
  `GetIsolate` and `PropertyCallbackInfo::This` were all removed from V8). Upgraded
  to v13, which builds cleanly.
- Dropped `@types/dompurify`, a stub that disagrees with dompurify v3's own types.

**Design**
- Design plan in `docs/DESIGN.md`: postal language (paper, wax, postmark, ink),
  three typefaces with distinct jobs, one accent, one radius.
- Letters are set in a reading serif. v0.0.2 set letter bodies in monospace.
- Contrast fixed at the source: the light theme's accent was `#7cb342`, which fails
  AA, and v0.0.2 patched it by adding a second accent token used only for text.
  Now `#b45309`, and no `--amber-text` hack.
- Mobile-first with a bottom tab bar. v0.0.2 claimed mobile-first and shipped zero
  media queries.
- Accessibility floor: landmarks, skip link, real labels, `:focus-visible` rings
  (v0.0.2 had none), 44px targets, `aria-live` on chess and archive state.
- Restored the letter-spine idea from the abandoned `public/style.css`, rebuilt on
  the token system.

**Cut**
- Jellyfin integration removed entirely (server routes, `server/jellyfin.js`,
  `server/config.js`, the media page, the media/player stores, MiniPlayer).
  Browsing a shared media server is not correspondence.

**Tests**
- 14 crypto tests covering round-trip, wrong password, third-party refusal,
  ciphertext tampering, and AAD re-addressing.
- 16 API tests covering auth, enumeration resistance, the single-pair constraint,
  delivery gating, upload hardening, and unauthenticated upload access.
- Playwright E2E driving two browser contexts: signup → pair → write → send →
  receive → decrypt, asserting the plaintext appears nowhere in the database.

### v2.0.0 - React client + prod Docker + fail-closed CI (2026-09-19)

- **Frontend**: React 18 + TypeScript + Vite client in `client/` (Zustand, React Router); backend serves `client/dist` in prod with SPA fallback.
- **Docker**: multi-stage build (node:20 client build → node:20-slim runtime), non-root `node` user, no build tools, 755 `data/`+`uploads/` owned by `node`, no baked secrets, `HEALTHCHECK` on `/healthz`, single-host `docker-compose.yml` with `./data`+`./uploads` volumes, `.env` file, `restart: unless-stopped`.
- **install.sh**: `docker compose up -d --build`; generates `JWT_SECRET` via openssl once if missing.
- **CI**: fail-closed (no `continue-on-error`); jobs lint (backend lint + client `tsc`), test (backend + client vitest), build (both), docker build without push on PR; GHCR push + SSH deploy stay on main pushes.
- **API**: `POST /api/pairing/reject`, `DELETE /api/pairs/unpair`, cursor pagination on letters/notifications (`limit`, `cursor`), `GET /healthz`.
- **Docs**: `.env.example` (JWT_SECRET, CORS_ORIGIN, JELLYFIN_URL/KEY/USER_ID, ADMIN_TOKEN, PORT); README v2 arch/quick-start/env/API; `.gitignore` covers `client/dist`, `client/node_modules`.

---

### v1.1.0 - Bug Fixes & DB Reset (2026-03-31)

#### Critical Fixes

**1. Encryption Key Naming Inconsistency (CRITICAL)**
- **Bug**: Client used `user.public_key` but server returned `user.publicKey` (camelCase)
- **Impact**: Letters could not be sent - "Failed to parse encryption keys" error
- **Files Changed**:
  - `server/index.js` line 172: `/api/me` now returns `publicKey as publicKey`
  - `server/index.js` line 248: Partner query now returns `public_key as publicKey`
  - `server/index.js` line 126: Signup response now includes `publicKey`
  - `public/app.js` line 476-477: Uses `publicKey` instead of `public_key`

**2. Signup Response Missing Keys**
- **Bug**: Signup endpoint did not return `publicKey` or `encryptedPrivateKey`
- **Impact**: After signup, `this.state.user.publicKey` was undefined
- **Fix**: Added keys to signup response

**3. Date Format Bug**
- **Bug**: `datetime-local` input returns `2026-03-31T14:30` (invalid ISO)
- **Impact**: Could cause SQLite date parsing issues
- **Fix**: Convert to proper ISO format: `new Date(dateInput).toISOString()`

**4. Duplicate Theme Switchers**
- **Bug**: Two theme switchers existed (toggle buttons + swatch grid)
- **Impact**: Confusing UX, broken `toggleThemeMode()` function
- **Fix**: Removed `theme-dark-toggle` div, kept only `theme-swatch` grid
- **Files Changed**:
  - `public/index.html`: Removed duplicate toggle buttons
  - `public/app.js`: Removed `toggleThemeMode()` function and event listeners

**5. Broken Theme Toggle Function**
- **Bug**: `toggleThemeMode()` tried to strip `-light`/`-dark` from theme names that no longer existed
- **Impact**: Theme switching broken for new 2-theme system
- **Fix**: Deleted function, updated `setTheme()` to handle both themes

#### New Features

**1. Database Reset Mechanism**
- Random 8-character code generated on server startup
- Code expires after 24 hours (auto-regenerates)
- Hidden reset section in Settings
- Endpoint: `POST /api/admin/reset-db`
- Code logged on startup: `[DB] Reset code: B1365B70`

**2. Debug Logging**
- Added console.log statements in `sendLetter()` to help troubleshoot encryption issues

#### Theme System Changes
- Replaced 14-theme system with 2 themes from `colors.md`
- **Dark Theme (default)**: `#0c0d0f` bg, `#e8a020` amber accent
- **Light Theme**: `#faf8f4` bg, `#7cb342` green accent

#### Documentation
- Created `docs/PLAN.md` with comprehensive improvement plan
- Created `.github/workflows/ci.yml` for CI/CD
- Updated `PROMOT.MD` with React requirements and known issues
- Updated `README.md` with new theme info
- Updated `.gitignore` for Vite/React build artifacts

---

### v1.0.0 - Initial Release (2026-03-27)

#### Features Implemented
- **Authentication**: Email/password signup/login
- **E2E Encryption**: RSA-OAEP (2048-bit) + AES-GCM (256-bit)
- **Pairing System**: PID-based pairing between users
- **Letter Exchange**: Encrypted letters with photo attachments
- **Letter Path**: SVG-based curved path visualization
- **Media Section**: Jellyfin integration with mini-player
- **Games**: Chess with minimax AI
- **Settings**: Profile editing, theme selection
- **Notifications**: Real-time alerts for pairing/letters

#### Tech Stack
- **Frontend**: Vanilla JavaScript, IndexedDB, Web Crypto API
- **Backend**: Node.js, Express, sql.js (SQLite)
- **Security**: bcryptjs, jsonwebtoken

---

## Known Issues & Fixes

### Letter Sending
| Error | Cause | Fix |
|-------|-------|-----|
| "Failed to parse encryption keys" | `publicKey` undefined | Both users must sign up with E2E enabled |
| "Your partner does have encryption keys" | Partner's key missing | Partner needs to sign up again |

### Key Naming Convention
- Server returns `publicKey` (camelCase) for user and partner
- Client must use `this.state.user.publicKey` NOT `user.public_key`

### Web Crypto API
- Requires secure context (HTTPS or localhost)
- Works: `http://localhost:3000`
- Fails: `http://192.168.x.x:3000`

---

## File Structure

```
pen-pal/
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions CI/CD
├── data/
│   └── penpal.db               # SQLite database
├── docs/
│   └── PLAN.md                 # Improvement plan
├── photos/                     # Reference screenshots
├── public/
│   ├── index.html              # Main HTML
│   ├── style.css               # Styles with theme variables
│   ├── app.js                  # Frontend logic
│   ├── crypto.js               # E2E encryption utilities
│   ├── db.js                   # IndexedDB wrapper
│   └── chess.js                # Chess game
├── server/
│   ├── index.js                # Express server
│   ├── db.js                   # Database helpers
│   ├── config.js               # Configuration
│   └── jellyfin.js             # Jellyfin integration
├── uploads/                    # User uploaded photos
├── colors.md                   # Theme color definitions
├── colors.html                 # Theme preview page
├── PROMOT.MD                   # Development instructions
├── README.md                   # Project documentation
├── CHANGELOG.md                # This file
├── .gitignore
├── .env
├── Dockerfile
├── install.sh
└── package.json
```

---

## API Endpoints

### Authentication
- `POST /api/signup` - Create account (returns keys)
- `POST /api/login` - Login (returns keys)
- `GET /api/me` - Get current user (returns keys)

### Pairing
- `POST /api/pairing/request` - Send pairing request
- `GET /api/pairing/status` - Get pairing status + partner info
- `POST /api/pairing/accept` - Accept pairing request

### Letters
- `POST /api/letters/send` - Send encrypted letter
- `GET /api/letters/sync` - Get all letters

### Media
- `POST /api/photos/upload` - Upload photo
- `GET /api/jellyfin/libraries` - Get Jellyfin libraries
- `GET /api/jellyfin/items` - Get library items
- `GET /api/jellyfin/status` - Check Jellyfin config

### Admin
- `POST /api/admin/reset-db` - Reset database (requires code)

### Notifications
- `GET /api/notifications` - Get notifications
- `PUT /api/notifications/read` - Mark as read

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| JWT_SECRET | change-this-secret | JWT signing secret |
| NODE_ENV | development | Environment mode |

---

## Database Schema

### users
```sql
id INTEGER PRIMARY KEY
username TEXT UNIQUE
friendly_name TEXT
email TEXT UNIQUE
password_hash TEXT
public_key TEXT          -- RSA public key (JWK format)
encrypted_private_key TEXT -- Encrypted RSA private key
pid TEXT UNIQUE          -- Pairing ID (6 chars)
age INTEGER
birthday TEXT
favorite_food TEXT
bio TEXT
avatar_url TEXT
profile_data TEXT
created_at DATETIME
```

### pairs
```sql
id INTEGER PRIMARY KEY
user1_id INTEGER
user2_id INTEGER
created_at DATETIME
```

### letters
```sql
id INTEGER PRIMARY KEY
sender_id INTEGER
recipient_id INTEGER
encrypted_content TEXT   -- AES encrypted letter content
encrypted_metadata TEXT  -- Encrypted metadata (photos, etc.)
photo_paths TEXT
sent_at DATETIME
delivered_at DATETIME
sync_version INTEGER
```

### pairings
```sql
id INTEGER PRIMARY KEY
requester_id INTEGER
target_pid TEXT
status TEXT              -- 'pending', 'accepted'
created_at DATETIME
```

### notifications
```sql
id INTEGER PRIMARY KEY
user_id INTEGER
type TEXT
title TEXT
body TEXT
read INTEGER
created_at DATETIME
```

### photos
```sql
id INTEGER PRIMARY KEY
user_id INTEGER
letter_id INTEGER
filename TEXT
filepath TEXT
created_at DATETIME
```

---

## Development Commands

```bash
# Install dependencies
npm install

# Run development server
npm start

# Run tests
npm test

# Run linting
npm run lint

# Build
npm run build
```

---

## Deployment

### Docker
```bash
docker build -t pen-pal-archive .
docker run -d -p 3000:3000 --name pen-pal pen-pal-archive
```

### One-Click Install
```bash
curl -fsSL github.com/2kfi/pen-pal-archive/install.sh | sudo bash
```

---

## Future Improvements (from PLAN.md)

### Phase 1: Critical (Done)
- [x] Fix letter sending bug
- [x] Fix duplicate theme changers
- [x] Add DB reset mechanism
- [x] Fix key naming inconsistency

### Phase 2: Architecture
- [ ] Migrate to React + TypeScript
- [ ] Implement Zustand state management
- [ ] Add React Router
- [ ] Add comprehensive tests

### Phase 3: UI/UX
- [ ] Rich text editor for letters
- [ ] Improved letter path visualization
- [ ] Better mobile responsiveness
- [ ] Animations and transitions

### Phase 4: Features
- [ ] OAuth (Google/Apple)
- [ ] Real-time notifications (WebSocket)
- [ ] Message timer/delivery delay
- [ ] Letter drafts auto-save

---

## Credits

Inspired by [Slowly](https://slowly.app/) - a pen pal app that simulates real letter delivery times.
