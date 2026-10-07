# Build stage: better-sqlite3 is native, so it may need a compiler. The runtime image doesn't ship one.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
# PostgreSQL 17 server + client: Postgres drills restore into a throwaway server inside this
# container (17 restores dumps from older servers too). SQLite drills don't need it.
# contrib: dumps that CREATE EXTENSION (pgcrypto, uuid-ossp, ...) need it to restore.
RUN apk add --no-cache postgresql17 postgresql17-client postgresql17-contrib
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js drill.js config.js s3.js pg.js alerts.js cli.js drills.yml ./
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
