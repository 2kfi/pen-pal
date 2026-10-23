#!/bin/bash
# install.sh for PenPal Archive (single-host Docker prod)
set -e
echo "Installing PenPal Archive..."

if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

# Generate JWT_SECRET once if missing
if [ ! -f .env ]; then
    cp .env.example .env
fi
if grep -q "change-me" .env; then
    SECRET=$(openssl rand -base64 32)
    # ponytail: sed in place, no extra deps
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" .env
    echo "Generated JWT_SECRET in .env"
fi

# --- bind-mount ownership ---
# The container runs as the image's `node` user (uid 1000), a deliberate
# non-root posture. Bind mounts replace the image's own /app/data and
# /app/uploads with the host's directories, and if Docker created those
# directories itself they are root:root — SQLite then dies with "unable to
# open database file". Hand them to uid 1000 before the first boot.
mkdir -p data uploads backups
if [ "$(id -u)" = "0" ]; then
    chown -R 1000:1000 data uploads backups
elif [ -n "$(find data uploads backups -not -user 1000 -print -quit 2>/dev/null)" ]; then
    echo "  ! state directories are not owned by uid 1000 and this script is"
    echo "    not running as root. Fix with: sudo chown -R 1000:1000 data uploads backups"
fi

docker compose up -d --build
echo "PenPal Archive is now running on http://localhost:3000"
