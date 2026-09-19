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

docker compose up -d --build
echo "PenPal Archive is now running on http://localhost:3000"
