# Frontend image (the v1.0.0 console) — built from the monorepo root context (the
# compose build context is `..`). It needs the root lockfile and the shared
# packages, so it installs from the root and builds only this workspace.
#
# **Retired but kept.** Since the Phase 14 switch, compose deploys the v3 console
# (frontend-next/Dockerfile) instead; this file is what
# deploy/docker-compose.legacy-frontend.yml swaps back in for a rollback. It is
# still built and tested in CI on purpose — an escape hatch that stopped building
# is not an escape hatch, and `@navfleet/fleet-core` is shared, so a change there
# can break this image without touching a file under `frontend/`.
FROM node:24-alpine AS build
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
