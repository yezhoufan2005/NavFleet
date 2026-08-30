# Console image (the v3 frontend) — built from the monorepo root context, like the
# other two. Runs alongside navfleet-frontend rather than replacing it; the
# switchover is a compose overlay in Phase 14.
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_AMAP_KEY=
ARG VITE_AMAP_SECURITY_JS_CODE=
ENV VITE_AMAP_KEY=$VITE_AMAP_KEY
ENV VITE_AMAP_SECURITY_JS_CODE=$VITE_AMAP_SECURITY_JS_CODE

# Every workspace manifest, not just this one: `npm ci` validates the lockfile
# against the complete workspace set and rejects it as out of sync if one is
# missing.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/fleet-core/package.json ./packages/fleet-core/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY frontend-next/package.json ./frontend-next/
RUN npm ci --ignore-scripts

COPY packages/shared ./packages/shared
COPY packages/fleet-core ./packages/fleet-core
COPY frontend-next ./frontend-next
RUN npm run build -w navfleet-console

FROM nginxinc/nginx-unprivileged:1.27-alpine
# Unlike the v1.0.0 frontend image, this one needs its own conf: web history means
# unknown paths must fall back to index.html. See frontend-next/nginx.conf.
COPY --from=build /app/frontend-next/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend-next/dist /usr/share/nginx/html
