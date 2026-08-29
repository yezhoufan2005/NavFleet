# Frontend image — built from the monorepo root context (see deploy/docker-compose.yml:
# frontend build context is `..`). Needs the root lockfile and the shared types
# package, so it installs from the root and builds the frontend workspace.
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_AMAP_KEY=
ARG VITE_AMAP_SECURITY_JS_CODE=
ENV VITE_AMAP_KEY=$VITE_AMAP_KEY
ENV VITE_AMAP_SECURITY_JS_CODE=$VITE_AMAP_SECURITY_JS_CODE

# Manifests + root lockfile first for a cache-friendly install layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/fleet-core/package.json ./packages/fleet-core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --ignore-scripts

# Shared types (type-only) + the shared fleet logic + frontend sources, then build
# the frontend workspace. `npm ci` above needs every workspace manifest listed or it
# refuses the lockfile as out of sync, and the build needs fleet-core's sources
# because the frontend imports it as a linked workspace, not a published tarball.
COPY packages/shared ./packages/shared
COPY packages/fleet-core ./packages/fleet-core
COPY frontend ./frontend
RUN npm run build -w navfleet-frontend

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
