# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci \
  && npx playwright install --with-deps chromium

FROM deps AS build
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_APP_URL=
ARG VITE_MARKET_DATA_PRIMARY=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_APP_URL=$VITE_APP_URL \
    VITE_MARKET_DATA_PRIMARY=$VITE_MARKET_DATA_PRIMARY
RUN npm run build

FROM node:22-alpine AS app
WORKDIR /app
RUN apk add --no-cache wget \
  && addgroup -g 1001 -S trazza \
  && adduser -S trazza -u 1001 -G trazza
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
# Express imports shared business logic from ../../src (relative to server/).
COPY src ./src
RUN mkdir -p /app/node_modules \
  && cp -a /app/server/node_modules/decimal.js /app/node_modules/ \
  && chown -R trazza:trazza /app/src /app/node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production \
    WEB_STATIC_ROOT=/app/dist \
    PORT=4000
USER trazza
WORKDIR /app/server
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1 || exit 1
CMD ["node", "index.js"]

FROM nginx:1.27.4-alpine AS web
RUN apk add --no-cache wget
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/templates/snippets/html-headers.conf.template /etc/nginx/templates/snippets/html-headers.conf.template
ENV CSP_SUPABASE_ORIGIN=https://*.supabase.co \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx \
    NGINX_ENVSUBST_FILTER=CSP_SUPABASE_ORIGIN
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1
EXPOSE 80
