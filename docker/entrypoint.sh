#!/bin/bash
set -e

echo "[Slorca] Starting Xvfb virtual display..."
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

# Wait for Xvfb to start
sleep 1

# Wait for Redis
echo "[Slorca] Waiting for Redis at ${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}..."
for i in $(seq 1 30); do
  if redis-cli -h "${REDIS_HOST:-localhost}" -p "${REDIS_PORT:-6379}" ping > /dev/null 2>&1; then
    echo "[Slorca] Redis is ready."
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[Slorca] WARNING: Redis not available after 30s. Starting anyway..."
  fi
  sleep 1
done

echo "[Slorca] Starting server..."
cd /app/backend

# Use exec so Node receives signals
exec node dist/index.js
