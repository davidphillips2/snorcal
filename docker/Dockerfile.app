# ---- Stage 1: Build frontend ----
FROM node:20-bookworm AS frontend-builder

WORKDIR /build
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/frontend/package.json ./packages/frontend/

ENV NPM_CONFIG_NODE_LINKER=hoisted

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

COPY packages/shared/ ./packages/shared/
COPY packages/frontend/ ./packages/frontend/

RUN pnpm --filter shared build && pnpm --filter frontend build

# ---- Stage 2: Build backend ----
FROM node:20-bookworm AS backend-builder

WORKDIR /build
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

ENV NPM_CONFIG_NODE_LINKER=hoisted

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

COPY packages/shared/ ./packages/shared/
COPY packages/backend/ ./packages/backend/

RUN pnpm --filter shared build && pnpm --filter backend build

# ---- Stage 3: App runtime (Node only, no slicers) ----
FROM node:20-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# redis-cli + curl for entrypoint wait loops
RUN apt-get update && apt-get install -y --no-install-recommends \
    redis-tools \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Root package.json is the single source of truth for the app version
# (read by /api/system/info via walk-up to find a package.json named "snorcal").
COPY --from=backend-builder /build/package.json /app/package.json

COPY --from=frontend-builder /build/packages/frontend/dist /app/frontend/dist
COPY --from=backend-builder /build/packages/backend/package.json /app/backend/package.json
COPY --from=backend-builder /build/packages/backend/dist /app/backend/dist
COPY --from=backend-builder /build/packages/shared/package.json /app/shared/package.json
COPY --from=backend-builder /build/packages/shared/dist /app/shared/dist
COPY --from=backend-builder /build/node_modules /app/node_modules

# Workspace pkg not auto-linked under hoisted — install manually so bare
# `import '@snorcal/shared'` resolves at runtime.
RUN mkdir -p /app/node_modules/@snorcal/shared \
    && cp /app/shared/package.json /app/node_modules/@snorcal/shared/package.json \
    && cp -r /app/shared/dist /app/node_modules/@snorcal/shared/dist

COPY docker/app-entrypoint.sh /app/app-entrypoint.sh
RUN chmod +x /app/app-entrypoint.sh

RUN mkdir -p /data/models /data/output /data/jobs /data/settings /data/print-photos

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV FRONTEND_DIR=/app/frontend/dist
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/app-entrypoint.sh"]
