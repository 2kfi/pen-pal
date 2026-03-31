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

## Tech Stack

- **Frontend**: React 18+, TypeScript, Vite, Zustand, React Router
- **Backend**: Node.js, Express, sql.js (SQLite), Axios
- **Styling**: CSS with theme variables from colors.md
- **Storage**: IndexedDB (client), SQLite (server)
- **Security**: RSA-OAEP (2048-bit), AES-GCM (256-bit), PBKDF2

## Quick Start

```bash
# Clone & install
npm install

# Run development server
npm start
```

Visit http://localhost:3000

## Deployment

### Docker

```bash
# Build
docker build -t pen-pal-archive .

# Run
docker run -d \
  -p 3000:3000 \
  --name pen-pal \
  -v $(pwd)/data:/usr/src/app/data \
  -v $(pwd)/uploads:/usr/src/app/uploads \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  pen-pal
```

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
| JWT_SECRET | (random) | Secret for JWT signing |
| NODE_ENV | production | Set to "development" for debug |

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

- `POST /api/signup` - Create account
- `POST /api/login` - Login
- `GET /api/me` - Get current user
- `PUT /api/me` - Update profile
- `POST /api/pairing/request` - Send pairing request
- `GET /api/pairing/status` - Get pairing status
- `POST /api/pairing/accept` - Accept pairing
- `POST /api/letters/send` - Send encrypted letter
- `GET /api/letters/sync` - Get all letters
- `POST /api/photos/upload` - Upload photo
- `GET /api/notifications` - Get notifications

## License

ISC
