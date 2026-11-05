# syntax=docker/dockerfile:1
# Multi-arch (amd64 + arm64) image for the Howth CG ops server.
#   docker buildx build --platform linux/amd64,linux/arm64 -t howth-cg-dashboard .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build -w web && npm run build -w server \
 && npm prune --omit=dev --workspace server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    WEB_DIST=/app/web/dist \
    CONFIG_FILE=/app/config.yaml \
    NODE_OPTIONS=--no-warnings=ExperimentalWarning
WORKDIR /app
RUN apk add --no-cache tini wget && mkdir -p /app/data && chown -R node:node /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node config.yaml ./config.yaml
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/server/src/index.js"]
