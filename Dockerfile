FROM rust:1.88-alpine AS umbral-builder

WORKDIR /build

RUN apk add --no-cache build-base protobuf

COPY WeVibe/wevibe-umbral-sidecar/Cargo.toml WeVibe/wevibe-umbral-sidecar/Cargo.lock ./
COPY WeVibe/wevibe-umbral-sidecar/build.rs ./
COPY WeVibe/wevibe-umbral-sidecar/proto ./proto
COPY WeVibe/wevibe-umbral-sidecar/src ./src

RUN cargo build --release

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
ENV WEVIBE_UMBRAL_SIDECAR_BIN=/usr/local/bin/wevibe-umbral-sidecar

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=umbral-builder /build/target/release/wevibe-umbral-sidecar /usr/local/bin/wevibe-umbral-sidecar
COPY WeVibe/wevibe-sdk/pkg-nodejs /wevibe-sdk/pkg-nodejs

EXPOSE 4450

CMD ["sh", "-c", "node dist/admin.js setup-identity && exec node dist/server.js"]
