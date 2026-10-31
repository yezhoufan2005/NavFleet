# Backend image — built from the monorepo root context (see deploy/docker-compose.yml:
# backend build context is `..`). npm workspaces means a single root lockfile and a
# shared types package, so the build installs from the root and builds the backend
# workspace specifically.
FROM node:24-alpine AS build
WORKDIR /app

# Manifests + root lockfile first for a cache-friendly install layer. Every workspace
# manifest has to be here even though the backend imports none of the frontend ones:
# `npm ci` validates the lockfile against the full workspace set and refuses it as out
# of sync if one is missing.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/fleet-core/package.json ./packages/fleet-core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY frontend-next/package.json ./frontend-next/
RUN npm ci --ignore-scripts

# Shared sources (bundled into the backend by esbuild — the backend imports runtime
# values from @navfleet/shared, not just types) + backend sources and build driver,
# then build the self-contained backend bundle.
COPY packages/shared ./packages/shared
COPY backend/tsconfig.json backend/tsconfig.build.json backend/build.mjs ./backend/
COPY backend/src ./backend/src
RUN npm run build -w navfleet-backend

# Demo fleet simulator (deploy/docker-compose.demo.yml). Runs the TypeScript sources with tsx from
# the build stage, which already holds the dev dependencies and the shared package source; it is
# never part of the runtime image.
FROM build AS sim
COPY backend/sim ./backend/sim
RUN mkdir -p /state && chown node:node /state
WORKDIR /app/backend
USER node
ENV SIM_STATE_DIR=/state CONFIG_ROOT_PATH=/runtime-config
HEALTHCHECK --interval=15s --timeout=5s --start-period=120m --retries=4 \
  CMD node -e "const s=require('fs').statSync('/state/live.heartbeat');process.exit(Date.now()-s.mtimeMs<15000?0:1)"
CMD ["sh", "-c", "npx tsx sim/main.ts catchup && exec npx tsx sim/main.ts live"]

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The backend's production dependencies only, resolved from the same root lockfile. `-w` keeps the
# frontends' runtime packages (vue, pinia, vue-router…) out of this image; the full manifest set is
# still copied so `npm ci` checks the lockfile against the same workspaces as the build stage.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/fleet-core/package.json ./packages/fleet-core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY frontend-next/package.json ./frontend-next/
RUN npm ci --omit=dev --ignore-scripts -w navfleet-backend --include-workspace-root \
  && npm cache clean --force

# Runtime config fallback (compose overrides via CONFIG_ROOT_PATH bind mount) + built output.
COPY config-runtime ./config-runtime
COPY --from=build /app/backend/dist ./backend/dist

# Drop root privileges for the runtime.
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/index.js"]
