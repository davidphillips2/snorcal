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

# ---- Stage 3: Download slicer binary ----
# Pulls the OrcaSlicer nightly build from the SimplyPrint/slicer-builds
# release. The zip ships a flat bin/ tree (orca-slicer + bundled .so libs).
# Override SLICER_URL to pin a specific release tag for reproducible builds.
FROM node:20-bookworm-slim AS slicer-fetch
ARG SLICER_URL=https://github.com/SimplyPrint/slicer-builds/releases/download/nightly/OrcaSlicer-linux-x86-64-nightly.zip
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /slicer
RUN curl -fsSL "${SLICER_URL}" -o slicer.zip \
    && unzip -q slicer.zip -d /opt/slicer \
    && rm slicer.zip \
    && chmod +x /opt/slicer/bin/orca-slicer 2>/dev/null || true \
    && test -f /opt/slicer/bin/orca-slicer

# ---- Stage 4: App runtime (Node + bundled slicer) ----
FROM node:20-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# redis-cli + curl for entrypoint wait loops; Xvfb + GL/GTK libs the slicer
# needs at runtime (the binary bundles most .so deps, but GL/GTK/Xvfb are
# system-level and must be present for headless rendering).
# Package names are Debian 12 (bookworm) — node:20-bookworm-slim base.
# (libjpeg62-turbo, not Ubuntu's libjpeg-turbo8; libwebkit2gtk-4.1-0 exists in bookworm.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    redis-tools \
    curl \
    ca-certificates \
    xvfb \
    libgl1-mesa-dri \
    libglu1-mesa \
    libglew2.2 \
    libgtk-3-0 \
    libwebkit2gtk-4.1-0 \
    libcurl4 \
    libtiff6 \
    libpng16-16 \
    libjpeg62-turbo \
    locales \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Slicer tree (binary + bundled libs). No resources/ dir in the upstream zip —
# snorcal embeds all settings in the 3MF directly, so SLICER_DATADIR is unset.
COPY --from=slicer-fetch /opt/slicer /opt/slicer

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

# Tell snorcal where the in-image slicer lives. executeLocal reads
# SLICER_PATH_<ENGINE> and wraps the binary in `xvfb-run` on Linux without a
# DISPLAY. With SLICER_URL_* unset, snorcal runs the same code path as
# bare-metal (no HTTP sidecar → output matches bare-metal).
ENV SLICER_PATH_ORCASLICER=/opt/slicer/bin/orca-slicer

EXPOSE 3000

ENTRYPOINT ["/app/app-entrypoint.sh"]
