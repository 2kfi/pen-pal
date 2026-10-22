# syntax=docker/dockerfile:1

# ---- client build -----------------------------------------------------------
FROM node:25-bookworm-slim AS client-build
WORKDIR /app/client

# Both lockfiles are committed. v0.0.2's .gitignore excluded them, which is why
# `npm ci` could never run and the image never built.
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build


# ---- dependencies -----------------------------------------------------------
# better-sqlite3 ships prebuilt binaries per Node ABI, but when one is not
# available its install script falls back to `node-gyp rebuild --release`.
# That needs python3 + make + g++, which node:*-slim does NOT have. The first
# attempt at this Dockerfile used the slim image for this step and the build
# died with a wall of gyp errors on GitHub Actions.
#
# So: compile in the full image, then copy the finished node_modules into the
# slim runtime. Same base, same ABI, same architecture, so the .node binary is
# valid — and the shipped image still has no compiler in it.
FROM node:25-bookworm AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ---- runtime ----------------------------------------------------------------
FROM node:25-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# libvips is not required: sharp ships prebuilt binaries via optionalDependencies
# (@img/sharp-linux-x64), so no system packages are needed for it either.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

COPY server/ ./server/

# The ops scripts, so a backup is possible from inside the container.
#
# docs/SELF-HOSTING.md tells an operator to back the database up, and the recipe
# it gave was `sqlite3 /app/data/penpal.db ".backup ..."` through `docker exec`.
# This runtime stage installs nothing, so sqlite3 is not in the image and that
# command could never have worked: the one documented way to save your letters
# was broken in the only place the image runs. These scripts are pure Node over
# better-sqlite3, which is already in node_modules above, so copying them in
# costs a few KB and makes `npm run backup` work inside the container.
COPY scripts/ ./scripts/
# NOTE: public/ is intentionally NOT copied. v0.0.2 served a legacy vanilla app
# here alongside React, so `/` and `/letters` were two different applications on
# one origin. The legacy app has since been deleted from the repo entirely.
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p data uploads backups \
    && chown -R node:node /app/data /app/uploads /app/backups \
    && chmod 700 /app/data \
    && chmod 750 /app/uploads

USER node

EXPOSE 3000

# Hits the DB-backed endpoint, not a static file.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]