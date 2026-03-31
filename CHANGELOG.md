# PenPal Archive - Changelog & Project Log

## Project Overview
A private, end-to-end (E2E) encrypted letter-sharing application inspired by Slowly. Features media browsing (Jellyfin) and casual gaming (Chess).

---

## Version History

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
