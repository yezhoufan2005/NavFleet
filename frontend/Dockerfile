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
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --ignore-scripts

# Shared types (source, type-only) + frontend sources, then build the frontend workspace.
COPY packages/shared ./packages/shared
COPY frontend ./frontend
RUN npm run build -w navfleet-frontend

FROM nginx:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
