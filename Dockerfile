FROM node:20-slim

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

EXPOSE 3000

# Health check so Docker knows if the app is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["npm", "start"]
