# Build client (React/Vite)
FROM node:20 AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Runtime: backend + built frontend, no build tools
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY public/ ./public/
COPY --from=client-build /app/client/dist ./client/dist
RUN mkdir -p data uploads && chown -R node:node /app/data /app/uploads && chmod 755 /app/data /app/uploads
USER node
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
