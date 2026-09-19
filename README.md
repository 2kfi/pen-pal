# PenPal Archive

A private, end-to-end (E2E) encrypted letter-sharing application inspired by Slowly. Features a premium, atmospheric design with media browsing and casual gaming.

## Key Features

- **E2E Encrypted Letters**: All correspondence encrypted locally using RSA-OAEP + AES-GCM. Only paired users can read them.
- **Premium UI**: Frosted glass cards, smooth CSS transitions, editorial typography.
- **2 Themes**: Dark (default) and Light themes with consistent color variables.
- **Letter Path**: Curved path visualization of your shared letter history.
- **Jellyfin Integration**: Browse Movies, Shows, Music with persistent mini-player.
- **Chess**: Play locally against a minimax AI.
- **Profile**: Customizable display name, bio, age, birthday, favorite food.
- **Notifications**: Real-time alerts for pairing requests and letters.

## Architecture (v2)

- **client/**: React 18 + TypeScript + Vite + Zustand + React Router. Dev on :5173 (proxies `/api` to :3000); prod build output `client/dist/` is served by the backend.
- **server/**: Node.js + Express + better-sqlite3 (WAL). Serves `client/dist` if built, plus `/uploads` and `public/`.
- **Prod**: single-host Docker (`Dockerfile` multi-stage + `docker-compose.yml`), SQLite in `./data`, uploads in `./uploads`.

## Quick Start

```bash
# Backend deps + dev server (:3000)
npm install
npm start

# Frontend dev (:5173, proxies /api to :3000)
npm --prefix client install
npm --prefix client run dev
```

Visit http://localhost:5173 (dev) or http://localhost:3000 (backend).

### Docker (prod, single host)

```bash
cp .env.example .env   # set JWT_SECRET (openssl rand -base64 32)
docker compose up -d --build
```

Or one-click: `sudo bash install.sh` (generates JWT_SECRET once if missing).

### Deployment

Single-host prod: `docker compose up -d --build` (builds client + server image, persists `./data` and `./uploads`, reads `.env`).

### One-Click Install

```bash
curl -fsSL github.com/2kfi/pen-pal-archive/install.sh | sudo bash
```

## Configuration

### Jellyfin (Optional)

Create `config.conf` in the directory **above** the project root:

```conf
SERVER_URL=http://your-jellyfin-ip:8096
API_KEY=your-jellyfin-api-key
USER_ID=your-jellyfin-user-id
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| JWT_SECRET | (required) | Secret for JWT signing; server refuses to boot in prod if missing/default |
| CORS_ORIGIN | same-origin in prod, open in dev | Comma-separated allowed origins |
| JELLYFIN_URL | — | Jellyfin server URL (optional media integration) |
| JELLYFIN_KEY | — | Jellyfin API key |
| JELLYFIN_USER_ID | — | Jellyfin user ID |
| ADMIN_TOKEN | — | Enables `POST /api/admin/reset-db` (non-prod only) |

## Theme System

The app uses 2 themes based on the color palette in `colors.md`:

### Dark Theme (Default)
- Background: `#0c0d0f`
- Accent: `#e8a020` (amber)
- Secondary: `#2ec4b6` (teal)

### Light Theme
- Background: `#faf8f4`
- Accent: `#7cb342` (green)
- Secondary: `#81c784` (teal)

Toggle themes in Settings or via the `easter-egg-active` CSS class.

## Security

- Private keys encrypted with user's password (AES-GCM + PBKDF2)
- Jellyfin credentials stored locally, never in DB or UI
- E2E encryption ensures server never sees plaintext

## API Endpoints

- `GET /healthz` - Health check (`{ ok: true }`)
- `POST /api/signup` - Create account
- `POST /api/login` - Login
- `GET /api/me` - Get current user
- `PUT /api/me` - Update profile
- `POST /api/pairing/request` - Send pairing request
- `GET /api/pairing/status` - Get pairing status
- `POST /api/pairing/accept` - Accept pairing
- `POST /api/pairing/reject` - Reject pairing
- `DELETE /api/pairs/unpair` - Remove current pair
- `POST /api/letters/send` - Send encrypted letter
- `GET /api/letters/sync?limit=&cursor=` - Get letters (cursor pagination, max 100/page)
- `POST /api/photos/upload` - Upload photo
- `GET /api/notifications?limit=&cursor=` - Get notifications (cursor pagination)
- `PUT /api/notifications/read` - Mark all as read

## License

ISC
