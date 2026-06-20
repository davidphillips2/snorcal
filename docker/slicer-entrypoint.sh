#!/bin/bash
set -e

echo "[Slicer Sidecar] Starting Xvfb on :99..."
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99
sleep 1

mkdir -p /data/models /data/output /data/jobs

echo "[Slicer Sidecar] Starting sidecar server..."
cd /app/slicer-sidecar
exec node dist/index.js
