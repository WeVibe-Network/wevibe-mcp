# Umbral PRE crypto ships inside the npm package as WebAssembly
# (vendor/umbral-wasm), so there is no Rust build stage and no sidecar binary
# to copy. Do not reintroduce WEVIBE_UMBRAL_SIDECAR_BIN — the MCP no longer
# reads it, and setting it will not make anything work.

FROM node:22-alpine AS build

WORKDIR /app

COPY WeVibe/wevibe-mcp/package.json WeVibe/wevibe-mcp/package-lock.json ./
RUN npm ci

COPY WeVibe/wevibe-mcp/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV WEVIBE_HTTP_HOST=0.0.0.0
ENV WEVIBE_HTTP_PORT=4450
ENV WEVIBE_KEYSTORE_PATH=/root/.wevibe/keys

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/vendor ./vendor
COPY WeVibe/wevibe-sdk/pkg-nodejs /wevibe-sdk/pkg-nodejs

EXPOSE 4450

CMD ["sh", "-c", "node dist/admin.js setup-identity && exec node dist/server.js"]
