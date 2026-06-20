#!/bin/bash
set -e

echo "[Snorcal App] Starting..."

# Wait for Redis
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

# Wait for slicer sidecar
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
