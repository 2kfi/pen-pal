# Use Node.js LTS
FROM node:20-slim

# Install dependencies for better-sqlite3 native build (if needed)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Create data and uploads directory
RUN mkdir -p data uploads && chmod 777 data uploads

# Expose port
EXPOSE 3000

# Set environment variables
ENV PORT=3000
ENV JWT_SECRET=change-this-to-a-secure-random-secret
ENV NODE_ENV=production

# Start the server
CMD [ "node", "server/index.js" ]
