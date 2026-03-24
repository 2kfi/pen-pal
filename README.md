# PenPal Archive

PenPal Archive is a private, end-to-end (E2E) encrypted letter-sharing application with a premium, atmospheric design. It's a digital sanctuary for slow, intentional communication, media browsing, and casual gaming.

## Key Features

- **E2E Encrypted Letters:** All correspondence is encrypted locally. Only you and your paired friend can read them.
- **Premium Atmospheric UI:** Dark-first design featuring frosted glass cards, subtle glow effects, smooth CSS transitions, and editorial-grade typography.
- **Winding Letter Path:** A dynamic, living path of your shared history. Letters feel "worn" once read.
- **Jellyfin Integration:** Browse your Jellyfin libraries (Movies, Shows, Music) and play audio in a persistent floating mini-player.
- **Games Section:** Play Chess locally against a minimax AI. Styled perfectly to match your chosen theme.
- **Three-Way Sync:** Letters are stored on the server and both paired devices for ultimate data safety.
- **Theming:** Five switchable high-contrast themes based on Arkan's Color Palette.

## Tech Stack

- **Backend:** Node.js, Express, SQLite, Axios.
- **Frontend:** Vanilla JS, IndexedDB, Web Crypto API.
- **Security:** RSA-OAEP, AES-GCM, PBKDF2.

## Deployment

### 1. Configure Jellyfin (Optional)
Create a `config.conf` file in the directory **above** the project root:
```conf
SERVER_URL=http://your-jellyfin-ip:8096
API_KEY=your-api-key
USER_ID=your-user-id
```

### 2. One-Click Installation
```bash
curl -fsSL github.com/2kfi/pen-pal-archive/install.sh | sudo bash
```

### 3. Manual Docker Deployment
```bash
docker build -t pen-pal-archive .
docker run -d \
  -p 3000:3000 \
  --name pen-pal-archive \
  -v $(pwd)/data:/usr/src/app/data \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  pen-pal-archive
```

## Security & Architecture

- **Private Keys:** Never sent to the server in plaintext. Encrypted with your password using AES-GCM before backup.
- **Media Privacy:** Jellyfin credentials are read from a local config file and never exposed to the UI or stored in the database.
- **Offline First:** IndexedDB ensures you can read your letters even without an internet connection.
