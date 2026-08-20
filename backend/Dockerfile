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

EXPOSE 3000
CMD ["npm", "run", "start"]
