# syntax=docker/dockerfile:1

# ---------- Build: install everything, build the Web App (static) and the server (tsc) ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only needed if a prebuilt better-sqlite3 binary is unavailable for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci
COPY server server
COPY webapp webapp
RUN npm run build

# ---------- Production dependencies for the server only ----------
# The root manifest is narrowed to the server workspace so none of the Web App's
# (build-time) dependencies end up in the runtime image; versions still come from the lockfile.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN node -e "const f='package.json',p=require('./'+f);p.workspaces=['server'];require('fs').writeFileSync(f,JSON.stringify(p))" \
  && npm install --omit=dev --no-audit --no-fund \
  && mkdir -p server/node_modules \
  && npm cache clean --force

# ---------- Runtime: Node.js + SQLite, nothing else ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6969 \
    DATABASE_URL=file:/app/data/gotyoubro.db \
    WEBAPP_DIST=/app/webapp/public
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/webapp/.output/public ./webapp/public

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 6969

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6969)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "dist/index.js"]
