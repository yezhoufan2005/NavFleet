FROM node:20-alpine AS build

WORKDIR /app
ARG VITE_AMAP_KEY=
ARG VITE_AMAP_SECURITY_JS_CODE=
ENV VITE_AMAP_KEY=$VITE_AMAP_KEY
ENV VITE_AMAP_SECURITY_JS_CODE=$VITE_AMAP_SECURITY_JS_CODE
COPY package*.json ./
RUN npm ci

COPY index.html ./
COPY vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
