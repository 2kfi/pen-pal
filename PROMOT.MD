I want you to build me a fullstack app.
BEFORE YOU START: Enter plan mode, write a full plan, then execute it step by step.
I want to build an app called PenPal Archive — a private, encrypted letter exchange app inspired by Slowly, with media and games built in.

1 — Database (SQLite)
Store auth and user/pair info. Fields:

Username, Friendly_Name, UID, PID (Pair ID to link users), E-Mail, Password
Private key, Public keys (one per peer + one for own storage) for E2E encryption
Profile extras: age, birthday, favorite food, 256-character bio, and anything else you find fitting


2 — Web UI
Prefer vanilla JS, HTML, and CSS over React — React is too heavy.
Themes are provided in @COLOR_PALETTE.html and @COLOR_PALETTE.md — follow them strictly. You may create additional themes using only the colors provided.
UI screens:

Login screen — supports Google and Apple OAuth (scaffold with proper callback structure; keep email/password fully functional), plus sign-up
Pairing screen — pair with a friend using PID so you both share a letter path; sends a pairing notification
Letter path / tree — a curved path like Duolingo or Candy Crush, ordered oldest to newest by date. Letters are written in Markdown and can include uploaded photos. Each node on the path is a letter you can open and read.
Media section — Jellyfin integration (see section 6)
Games section — chess and more (see section 7)
Settings — theme switcher (light/dark, defaults to system preference), profile editing


3 — Sync
Three copies total: one on the server, one on each paired device. Include a sync button in the UI. Use persistent local storage (IndexedDB) on the client side — not just cache. Sync traffic must be encrypted using the user's E2E key pair established during pairing.

4 — End-to-end encryption
All letters and synced data must be E2E encrypted using the key pair established at pairing. I will handle the reverse proxy on my end.

5 — UI Design Language
Dark-first, premium, atmospheric. Use the provided palette — deep purples, crimsons, and near-blacks as the base. Apply:

Frosted glass cards with subtle border glow
Smooth CSS page transitions — no animation libraries
Micro-interactions on buttons, letter nodes, and nav items
The letter path should feel alive — nodes pulse gently on hover, completed letters look worn and vintage
Typography should feel editorial — large headings, comfortable reading width for letter content
The overall feel should be moody, intimate, and premium — like a private journal meets a luxury app


6 — Jellyfin Integration
Add a dedicated Media section. Read server_url, api_key, and jellyfin_user_id from a config.conf file stored outside the app directory — never hardcoded, never in the DB or UI settings. Features:

Browse libraries (Movies, Shows, Music)
Play media in a floating mini-player that persists across all screens
Use Jellyfin's REST API directly — no re-authentication inside the app
If config.conf values are missing, show a friendly "Media not configured" placeholder — don't crash


7 — Games Section
Add a Games tab. Include one fully working game: Chess, playable locally against a simple minimax AI. The board must use the app's color palette. Scaffold a "Play vs friend" mode for paired users but mark it as coming soon — do not implement it fully yet.

Things to consider:

Strictly follow the color palettes in @COLOR_PALETTE.html and @COLOR_PALETTE.md
Letters and pairing are the core of this app — Jellyfin and Games are secondary. Do not let them delay or break the core.
Must be redeployable — include a Dockerfile and an install script accessible via:
curl -fsSL github.com/2kfi/pen-pal-archive/install.sh | sudo bash
Modern, smooth, and designed for everyday use
Optional message timer:

Notification when a message arrives
Notification when a message arrives after its set delivery timer elapses
Notification when someone requests pairing


Add a full README covering: all sections, architecture overview, environment variables, deployment via Docker, and manual install steps