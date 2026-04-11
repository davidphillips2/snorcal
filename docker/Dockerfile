# ---- Stage 1: Build frontend ----
FROM node:20-bookworm AS frontend-builder

WORKDIR /build
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/frontend/package.json ./packages/frontend/

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

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

COPY packages/shared/ ./packages/shared/
COPY packages/backend/ ./packages/backend/

RUN pnpm --filter shared build && pnpm --filter backend build

# ---- Stage 3: Production runtime ----
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies for slicers (GUI libs needed even in headless mode)
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libxtst6 \
    libasound2 \
    libgbm1 \
    libdrm2 \
    libx11-xcb1 \
    libgl1-mesa-glx \
    libglu1-mesa \
    libglew2.2 \
    libcurl4 \
    wget \
    curl \
    ca-certificates \
    fuse \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install OrcaSlicer (Phase 1 — only engine for now)
# Note: Update the version URL to the latest release
RUN mkdir -p /opt/orcaslicer && \
    wget -qO /tmp/orcaslicer.AppImage \
      "https://github.com/SoftFever/OrcaSlicer/releases/download/v2.3.0/OrcaSlicer_Linux_Ubuntu_V2.3.0.AppImage" && \
    chmod +x /tmp/orcaslicer.AppImage && \
    cd /opt/orcaslicer && \
    /tmp/orcaslicer.AppImage --appimage-extract && \
    mv squashfs-root/* . 2>/dev/null || true && \
    rm -rf squashfs-root /tmp/orcaslicer.AppImage && \
    ln -sf /opt/orcaslicer/OrcaSlicer /usr/local/bin/orca-slicer

# Install BambuStudio (Phase 3)
# RUN mkdir -p /opt/bambustudio && \
#     wget -qO /tmp/bambustudio.AppImage \
#       "https://github.com/bambulab/BambuStudio/releases/download/v01.10.00/BambuStudio_linux_ubuntu_v01.10.00.AppImage" && \
#     chmod +x /tmp/bambustudio.AppImage && \
#     cd /opt/bambustudio && \
#     /tmp/bambustudio.AppImage --appimage-extract && \
#     mv squashfs-root/* . 2>/dev/null || true && \
#     rm -rf squashfs-root /tmp/bambustudio.AppImage && \
#     ln -sf /opt/bambustudio/BambuStudio /usr/local/bin/bambu-studio

# Install Snapmaker OrcaSlicer (Phase 3)
# RUN mkdir -p /opt/snapmaker-orca && \
#     wget -qO /tmp/snapmaker-orca.AppImage "..." && \
#     ...

# Copy application
COPY --from=frontend-builder /build/packages/frontend/dist /app/frontend/dist
COPY --from=backend-builder /build/packages/backend/dist /app/backend/dist
COPY --from=backend-builder /build/node_modules /app/node_modules
COPY --from=backend-builder /build/packages/backend/node_modules /app/backend/node_modules
COPY --from=backend-builder /build/packages/shared/dist /app/shared/dist
COPY --from=backend-builder /build/packages/shared/node_modules /app/shared/node_modules

# Copy entrypoint
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create data directories
RUN mkdir -p /data/models /data/output /data/jobs /data/settings

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV FRONTEND_DIR=/app/frontend/dist
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
