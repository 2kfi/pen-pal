# syntax=docker/dockerfile:1

# ---- client build -----------------------------------------------------------
FROM node:22-bookworm-slim AS client-build
WORKDIR /app/client

# Both lockfiles are committed (v0.0.2's .gitignore excluded them, which is why
# `npm ci` could never run and the image never built).
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build


# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# libvips/sharp is added later (plan step 21); better-sqlite3 needs a toolchain
# only if no prebuilt binary matches, so the runtime stays slim.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
# NOTE: public/ is no longer copied. v0.0.2 shipped the legacy vanilla app here
# and mounted it with express.static(), so `/` served the old app while `/letters`
# served React — two apps, one origin. There is exactly one app now.
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p data uploads \
    && chown -R node:node /app/data /app/uploads \
    && chmod 700 /app/data \
    && chmod 755 /app/uploads

USER node

EXPOSE 3000

# Health check hits the DB-backed endpoint, not just a static file.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]