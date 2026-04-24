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
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---- Slicers from SimplyPrint/slicer-builds ----
# These are custom Linux builds with bundled .so files — no AppImage/FUSE needed.
# Structure: bin/<binary> + bin/*.so + resources/

ARG ORCASLICER_VERSION=OrcaSlicer_v2.3.2
ARG BAMBUSTUDIO_VERSION=BambuStudio_v02.05.00.67

# Install OrcaSlicer
RUN mkdir -p /opt/orcaslicer && \
    wget -qO /tmp/orcaslicer.zip \
      "https://github.com/SimplyPrint/slicer-builds/releases/download/${ORCASLICER_VERSION}/OrcaSlicer-v2.3.2.zip" && \
    cd /tmp && unzip -q orcaslicer.zip -d /opt/orcaslicer && \
    chmod +x /opt/orcaslicer/bin/orca-slicer && \
    rm /tmp/orcaslicer.zip

# Install BambuStudio
RUN mkdir -p /opt/bambustudio && \
    wget -qO /tmp/bambustudio.zip \
      "https://github.com/SimplyPrint/slicer-builds/releases/download/${BAMBUSTUDIO_VERSION}/BambuStudio-v02.05.00.67.zip" && \
    cd /tmp && unzip -q bambustudio.zip -d /opt/bambustudio && \
    chmod +x /opt/bambustudio/bin/bambu-studio && \
    rm /tmp/bambustudio.zip

# Snapmaker Orca uses the OrcaSlicer binary with a different datadir
# (set via SLICER_DATADIR env or --datadir flag)
RUN ln -sf /opt/orcaslicer /opt/snapmaker-orca

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

# Set LD_LIBRARY_PATH so slicers find their bundled .so files
ENV LD_LIBRARY_PATH=/opt/orcaslicer/bin:/opt/bambustudio/bin

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
