#!/bin/bash
# install.sh for PenPal Archive

set -e

echo "Installing PenPal Archive..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

# Build and Run
docker build -t pen-pal-archive .
docker run -d \
  -p 3000:3000 \
  --name pen-pal-archive \
  -v $(pwd)/data:/usr/src/app/data \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  pen-pal-archive

echo "PenPal Archive is now running on http://localhost:3000"
