# Use Node.js LTS
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy app source
COPY . .

# Create data and uploads directory
RUN mkdir -p data uploads && chmod 777 data uploads

# Expose port
EXPOSE 3000

# Set environment variables
ENV PORT=3000
ENV JWT_SECRET=change-this-to-a-secure-secret
ENV NODE_ENV=production

# Start the server
CMD [ "node", "server/index.js" ]
