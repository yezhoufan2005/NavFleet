# Backend image — built from the monorepo root context (see deploy/docker-compose.yml:
# backend build context is `..`). npm workspaces means a single root lockfile and a
# shared types package, so the build installs from the root and builds the backend
# workspace specifically.
FROM node:20-alpine AS build
WORKDIR /app

# Manifests + root lockfile first for a cache-friendly install layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --ignore-scripts

# Shared types (source, type-only) + backend sources, then build the backend workspace.
COPY packages/shared ./packages/shared
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src ./backend/src
RUN npm run build -w navfleet-backend

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only, resolved from the same root lockfile.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Runtime config fallback (compose overrides via CONFIG_ROOT_PATH bind mount) + built output.
COPY config-runtime ./config-runtime
COPY --from=build /app/backend/dist ./backend/dist

# Drop root privileges for the runtime.
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/index.js"]
