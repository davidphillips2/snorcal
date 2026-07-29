#!/usr/bin/env bash
# Start or restart snorcal dev servers (backend :3000 + frontend :5173).
#
#   ./dev.sh         start if not running, else restart both
#   ./dev.sh status  show what's running without changing anything
#
# Logs go to /tmp/snorcal-{backend,frontend}.log
# Backend runs under tsx watch (auto-reloads on edit). Frontend under vite.

set -euo pipefail
cd "$(dirname "$0")"

BACK_PORT=3000
FRONT_PORT=5173
BE_LOG=/tmp/snorcal-backend.log
FE_LOG=/tmp/snorcal-frontend.log

# Match the dev servers and their watcher children. Scoped to this repo so a
# stray vite/tsx elsewhere isn't touched. pnpm-filter matches the dev parent.
kill_dev() {
  pkill -f "pnpm.*--filter backend run dev" 2>/dev/null || true
  pkill -f "pnpm.*--filter frontend run dev" 2>/dev/null || true
  pkill -f "tsx watch src/index.ts" 2>/dev/null || true
  # Vite: match only the one bound to our port to avoid hitting other projects.
  local pid
  pid=$(lsof -ti:$FRONT_PORT 2>/dev/null || true)
  [ -n "$pid" ] && kill $pid 2>/dev/null || true
  # Give sockets a moment to free before we rebind.
  sleep 1
}

is_listening() { lsof -ti:"$1" >/dev/null 2>&1; }

start_dev() {
  mkdir -p "$(dirname "$BE_LOG")" "$(dirname "$FE_LOG")"
  # Detach so the script can exit; each server logs to its own file.
  # Preserve the repo's dev env (UV_THREADPOOL_SIZE=16 for backend).
  ( cd packages/backend  && nohup pnpm run dev > "$BE_LOG" 2>&1 & ) 2>/dev/null
  ( cd packages/frontend && nohup pnpm run dev > "$FE_LOG" 2>&1 & ) 2>/dev/null
  echo "starting… (logs: $BE_LOG, $FE_LOG)"
}

wait_for() {
  # $1=port $2=timeout_sec — block until something listens or timeout.
  local port=$1 timeout=${2:-25} elapsed=0
  while ! is_listening "$port"; do
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "  ⚠ port $port not up after ${timeout}s — check the log"
      return 1
    fi
    sleep 1
  done
  echo "  ✓ :$port up (${elapsed}s)"
}

status() {
  if is_listening $BACK_PORT; then
    echo "backend  :$BACK_PORT  $(curl -s http://localhost:$BACK_PORT/api/health 2>/dev/null | head -c 80 || echo '(no health response)')"
  else
    echo "backend  :$BACK_PORT  DOWN"
  fi
  if is_listening $FRONT_PORT; then
    echo "frontend :$FRONT_PORT  UP"
  else
    echo "frontend :$FRONT_PORT  DOWN"
  fi
}

case "${1:-run}" in
  status)
    status
    ;;
  restart)
    echo "restarting dev servers…"
    kill_dev
    start_dev
    wait_for $BACK_PORT 30 || true
    wait_for $FRONT_PORT 30 || true
    ;;
  run|"")
    if is_listening $BACK_PORT && is_listening $FRONT_PORT; then
      echo "already running — restarting"
      kill_dev
      start_dev
    else
      echo "not fully running — starting"
      # Partial state (one up, one down): restart both for a clean slate.
      kill_dev
      start_dev
    fi
    wait_for $BACK_PORT 30 || true
    wait_for $FRONT_PORT 30 || true
    ;;
  *)
    echo "usage: $0 [status|restart]" >&2
    exit 1
    ;;
esac
