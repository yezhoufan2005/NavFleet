FROM node:20-alpine AS build

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
RUN npm run build

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY config-runtime ./config-runtime
COPY --from=build /app/dist ./dist

# Drop root privileges for the runtime.
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
