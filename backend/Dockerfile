# syntax=docker/dockerfile:1
# pump.social API — same image locally (Docker Desktop) and on the VPS.

# ---- build: compile TypeScript -------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- geoip: self-hosted IP→country database (DB-IP Lite, CC BY 4.0) -----
# Cached by Docker; `docker compose build --no-cache api` refreshes it.
FROM node:22-alpine AS geoip
WORKDIR /app
COPY scripts/fetch-geoip.mjs ./
RUN mkdir -p data && node fetch-geoip.mjs data/dbip-country-lite.mmdb

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY --from=geoip /app/data ./data
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
