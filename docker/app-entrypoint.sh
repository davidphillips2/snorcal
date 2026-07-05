#!/bin/bash
set -e

echo "[Snorcal App] Starting..."

# Wait for Redis (skip if REDIS_HOST is blank — Redis is optional)
if [ -n "$REDIS_HOST" ]; then
  echo "[Snorcal App] Waiting for Redis at ${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}..."
  for i in $(seq 1 30); do
    if redis-cli -h "${REDIS_HOST:-localhost}" -p "${REDIS_PORT:-6379}" ping > /dev/null 2>&1; then
      echo "[Snorcal App] Redis ready."
      break
    fi
    if [ $i -eq 30 ]; then
      echo "[Snorcal App] WARNING: Redis not available after 30s."
    fi
    sleep 1
  done
else
  echo "[Snorcal App] REDIS_HOST unset — skipping Redis (direct slice mode)."
fi

# --- Slicer fetch (runtime choice, cached in /data volume) ---
# SLICER_ENGINE decides which SimplyPrint/slicer-builds nightly zip to pull.
# Cached at /data/slicers/<engine>/ so first-boot is the only slow start.
# Skipping only if SLICER_URL_* is set (external sidecar mode).
SLICER_BASE=${SLICER_BASE_URL:-https://github.com/SimplyPrint/slicer-builds/releases/download/nightly}
DATA_DIR=${DATA_DIR:-/data}
SLICER_DIR="$DATA_DIR/slicers"

ensure_slicer() {
  local engine="$1"   # orcaslicer | bambustudio
  local pretty="$2"   # OrcaSlicer  | BambuStudio
  local binary="$3"   # orca-slicer | bambu-studio
  local dest="$SLICER_DIR/$engine"

  # External sidecar mode — don't fetch, the HTTP path is used instead.
  local url_env="SLICER_URL_$(echo "$engine" | tr '[:lower:]' '[:upper:]')"
  if [ -n "${!url_env}" ]; then
    echo "[Snorcal App] SLICER_URL_${engine^^} set — skipping $pretty fetch (sidecar mode)."
    return
  fi

  if [ -x "$dest/bin/$binary" ]; then
    echo "[Snorcal App] $pretty already present at $dest — reusing."
  else
    local zip_name="${pretty}-linux-x86-64-nightly.zip"
    local zip_url="${SLICER_BASE}/${zip_name}"
    echo "[Snorcal App] Fetching $pretty from $zip_url..."
    mkdir -p "$dest"
    if curl -fsSL "$zip_url" -o /tmp/"$zip_name"; then
      unzip -q /tmp/"$zip_name" -d "$dest"
      rm -f /tmp/"$zip_name"
      chmod +x "$dest/bin/$binary" 2>/dev/null || true
      echo "[Snorcal App] $pretty installed at $dest."
    else
      echo "[Snorcal App] WARNING: failed to fetch $pretty ($zip_url). Slicing with $engine will not work."
      rm -rf "$dest"
    fi
  fi

  if [ -x "$dest/bin/$binary" ]; then
    # Export so snorcal (node child) sees it. uppercase engine → SLICER_PATH_ORCASLICER etc.
    export SLICER_PATH_$(echo "$engine" | tr '[:lower:]' '[:upper:]')="$dest/bin/$binary"
    echo "[Snorcal App]   SLICER_PATH_${engine^^}=$dest/bin/$binary"
  fi
}

case "${SLICER_ENGINE:-orca}" in
  orca)
    ensure_slicer orcaslicer OrcaSlicer orca-slicer
    ;;
  bambu)
    ensure_slicer bambustudio BambuStudio bambu-studio
    ;;
  both)
    ensure_slicer orcaslicer OrcaSlicer orca-slicer
    ensure_slicer bambustudio BambuStudio bambu-studio
    ;;
  *)
    echo "[Snorcal App] Unknown SLICER_ENGINE='$SLICER_ENGINE' (expected orca|bambu|both). No slicer fetched."
    ;;
esac

# Wait for slicer sidecar (only if an explicit SLICER_URL was set)
if [ -n "$SLICER_URL" ]; then
  echo "[Snorcal App] Waiting for slicer sidecar at $SLICER_URL..."
  for i in $(seq 1 60); do
    if curl -sf "$SLICER_URL/health" > /dev/null 2>&1; then
      echo "[Snorcal App] Slicer sidecar ready."
      break
    fi
    if [ $i -eq 60 ]; then
      echo "[Snorcal App] WARNING: slicer sidecar not reachable after 60s."
    fi
    sleep 1
  done
fi

cd /app/backend
exec node dist/index.js
