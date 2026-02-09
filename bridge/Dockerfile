FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --production

RUN mkdir -p /data/whatsapp-sessions

EXPOSE 8080

CMD ["node", "dist/index.js"]
