# PenPal Archive - Development Instructions

## IMPORTANT: Enter Plan Mode First
Before writing any code, create a comprehensive plan with phases, then execute step by step.

## After Every Change
- Update `.gitignore` if new file types/directories are added
- Update `README.md` to reflect any feature or architecture changes
- Update `CHANGELOG.md` with a summary of the change

---

## Tech Stack Requirements

### Frontend
- **React 18+** with TypeScript
- **Vite** for build tooling
- **React Router v6** for client-side routing
- **Zustand** or React Context for state management
- **CSS Modules** or styled-components for styling
- **Theme System**: Use exactly 2 themes from `@colors.md` and `@colors.html`:
  - **Dark Theme (default)**: `#0c0d0f` background, `#e8a020` amber accent
  - **Light Theme (easter-egg-active)**: `#faf8f4` background, `#7cb342` green accent

### Backend
- **Node.js** with Express
- **SQLite** with sql.js for database
- **JWT** for authentication
- **bcryptjs** for password hashing

---

## 1. Database Schema

### Users Table
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  friendly_name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  public_key TEXT,
  encrypted_private_key TEXT,
  pid TEXT UNIQUE NOT NULL,
  age INTEGER,
  birthday TEXT,
  favorite_food TEXT,
  bio TEXT DEFAULT '',
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Additional Tables
- `pairs` (user1_id, user2_id, created_at)
- `letters` (id, sender_id, recipient_id, encrypted_content, encrypted_metadata, photo_paths, sent_at, delivered_at, sync_version)
- `pairings` (requester_id, target_pid, status, created_at)
- `notifications` (user_id, type, title, body, read, created_at)
- `photos` (user_id, letter_id, filename, filepath, created_at)

---

## 2. Frontend Screens & Components

### 2.1 Authentication
- **Login Page**: Email/password form, OAuth buttons (Google/Apple - scaffolded)
- **Signup Page**: Username, email, password, profile extras

### 2.2 Main App Layout
```
App/
├── AuthenticatedLayout/
│   ├── Sidebar (Navigation)
│   ├── MainContent/
│   │   ├── LettersPage/
│   │   ├── PairingPage/
│   │   ├── MediaPage/
│   │   ├── GamesPage/
│   │   └── SettingsPage/
│   └── MiniPlayer (persistent across screens)
└── ThemeProvider (handles dark/light switch)
```

### 2.3 Letters Section
- **LetterPath**: Curved path visualization (like Duolingo/Candy Crush)
- **LetterNode**: Individual letter nodes that pulse on hover
- **LetterComposer**: Markdown editor with photo attachments
- **LetterReader**: Beautiful typography for reading letters

### 2.4 Pairing System
- **PID Display**: Show user's pairing code
- **PairingRequest**: Input field for partner's PID
- **PartnerManagement**: View current partner, incoming requests

### 2.5 Media Section
- **JellyfinBrowser**: Browse libraries (Movies, Shows, Music)
- **MiniPlayer**: Floating audio/video player
- **ConfigCheck**: Show "Media not configured" if config.conf missing

### 2.6 Games Section
- **ChessGame**: Play vs minimax AI
- **GameBoard**: Uses app's color palette
- **ComingSoon**: "Play vs Friend" placeholder

### 2.7 Settings
- **ThemeSwitcher**: Toggle between dark/light themes
- **ProfileEditor**: Edit name, bio, age, birthday, favorite food
- **NotificationSettings**: Configure alerts

---

## 3. Core Features

### 3.1 End-to-End Encryption
- RSA-OAEP (2048-bit) for key exchange
- AES-GCM (256-bit) for letter content
- PBKDF2 for key derivation from password
- Private keys encrypted with user's password

### 3.2 Sync System
- Three copies: server + 2 paired devices
- IndexedDB for local storage (not cache)
- Sync button in UI
- Encrypted sync traffic using E2E keys

### 3.3 Notification System
- Real-time pairing requests
- Letter arrival notifications
- Timer-based delivery notifications

---

## 4. UI Design Language

### 4.1 Theme Application
Follow `@colors.md` and `@colors.html` **strictly**. Use these CSS variables:

**Dark Theme (default)**:
```css
--bg: #0c0d0f;
--bg2: #111418;
--bg3: #181d24;
--border: #1f2631;
--amber: #e8a020;
--amber2: #f5c048;
--teal: #2ec4b6;
--text: #c8d4e0;
--white: #eef3f8;
```

**Light Theme**:
```css
--bg: #faf8f4;
--bg2: #ffffff;
--bg3: #fafafa;
--border: #d4dcc8;
--amber: #7cb342;
--amber2: #9ccc65;
--teal: #81c784;
--text: #4a5a3e;
--white: #2e3d24;
```

### 4.2 Visual Elements
- Frosted glass cards with subtle border glow
- Smooth CSS transitions (no animation libraries)
- Micro-interactions on hover
- Editorial typography (large headings, comfortable reading width)
- Letter path with pulsing nodes, vintage worn look for old letters

### 4.3 Mobile-First Design
- Responsive layout for all screen sizes
- Touch-friendly controls
- Sidebar collapses on mobile

---

## 5. Jellyfin Integration

### 5.1 Configuration
Read from `config.conf` in parent directory:
```
SERVER_URL=http://your-jellyfin-ip:8096
API_KEY=your-jellyfin-api-key
USER_ID=your-jellyfin-user-id
```

### 5.2 Features
- Browse libraries without re-authentication
- Floating mini-player across all screens
- Graceful fallback if not configured

---

## 6. Games

### 6.1 Chess
- Local play against minimax AI
- Board uses app's color palette
- "Play vs Friend" mode (scaffolded, coming soon)

---

## 7. Deployment

### 7.1 Docker
Include Dockerfile with multi-stage build and persistent volumes for data and uploads

### 7.2 One-Click Install
```bash
curl -fsSL github.com/2kfi/pen-pal-archive/install.sh | sudo bash
```

### 7.3 Environment Variables
- `PORT` (default: 3000)
- `JWT_SECRET` (auto-generated if not provided)

---

## 8. Implementation Checklist

### Phase 1: Foundation
- [ ] Setup React + TypeScript + Vite project
- [ ] Implement theme system from colors.md
- [ ] Create basic routing structure
- [ ] Set up database schema

### Phase 2: Core Features
- [ ] Authentication (login/signup)
- [ ] Letter composition and reading
- [ ] Pairing system
- [ ] Basic sync functionality

### Phase 3: Enhanced Features
- [ ] Letter path visualization
- [ ] Media section with Jellyfin
- [ ] Chess game
- [ ] Notifications

### Phase 4: Polish & Deploy
- [ ] UI/UX polish
- [ ] Mobile responsiveness
- [ ] Docker setup
- [ ] Documentation

---

## 9. Priority Order

**MUST HAVE (Core)**:
1. Authentication
2. Letter exchange with E2E encryption
3. Pairing system
4. Theme system from colors.md

**SHOULD HAVE**:
1. Letter path visualization
2. Sync with IndexedDB
3. Notifications
4. Settings/profile

**NICE TO HAVE**:
1. Jellyfin integration
2. Chess game
3. OAuth (Google/Apple)

---

## 10. Testing Requirements
- Unit tests for critical functions
- Integration tests for API endpoints
- E2E tests for main user flows
- 80%+ code coverage target

---

## 11. Known Issues & Common Fixes

### Letter Sending Fails
**Error: "Failed to parse encryption keys"**
- Cause: User's or partner's `publicKey` is undefined/null
- Fix: Both users must sign up AFTER the E2E encryption was added
- Check: User's `publicKey` must be present in `this.state.user.publicKey`

**Error: "Your partner does not have encryption keys"**
- Partner needs to sign up again to generate keys
- Old accounts (created before E2E) don't have encryption keys

### Key Naming Convention (CRITICAL)
- Server returns `publicKey` (camelCase) for logged-in user
- Server returns `publicKey` (camelCase) for partner (via SQL alias)
- Client must use `this.state.user.publicKey` NOT `this.state.user.public_key`

### Date Format
- `datetime-local` input returns `2026-03-31T14:30` (invalid ISO)
- Must convert: `new Date(dateInput).toISOString()`

### Theme Switcher
- Only ONE theme switcher should exist (theme-grid with theme-swatch buttons)
- Remove any `theme-dark-toggle` div if present
- Use `setTheme('dark')` or `setTheme('light')` - not `toggleThemeMode()`

### Database Reset
- Reset code shown on server startup: `[DB] Reset code: XXXXXXXX`
- Code changes on server restart and every 24 hours
- Reset endpoint: `POST /api/admin/reset-db` with `{ "code": "XXXXXXXX" }`

### HTTP vs HTTPS
- Web Crypto API requires secure context (HTTPS or localhost)
- Works: `http://localhost:3000`, `http://127.0.0.1:3000`
- Fails: `http://192.168.x.x:3000` (non-localhost HTTP)