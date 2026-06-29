#!/usr/bin/env bash
# Snorcal bare-metal uninstaller for macOS + Linux.
#
# Stops the service, removes the service definition, optionally deletes the
# install dir and (with --purge) the data dir (DB / models / jobs).
#
# Usage:
#   bash uninstall.sh              # stop service + remove service + remove install dir
#   bash uninstall.sh --keep-install  # leave install dir alone
#   bash uninstall.sh --purge      # ALSO delete ~/.snorcal (DB, models, jobs, logs)
#
# Re-run safely even if service is already gone.
set -euo pipefail

SERVICE_LABEL="com.snorcal.backend"

log()   { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

KEEP_INSTALL=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --keep-install) KEEP_INSTALL=1 ;;
    --purge)        PURGE=1 ;;
    -h|--help)
      cat <<EOF
Usage: bash uninstall.sh [--keep-install] [--purge]
  (default)        stop service, remove service unit, remove $HOME/snorcal
  --keep-install   stop service, remove service unit, keep $HOME/snorcal
  --purge          ALSO remove $HOME/.snorcal (DB, models, jobs, logs)
EOF
      exit 0 ;;
    *) die "Unknown flag: $arg (try --help)" ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *)      die "Unsupported OS: $OS. On Windows use uninstall.ps1." ;;
esac

INSTALL_DIR="${SNORCAL_HOME:-$HOME/snorcal}"
DATA_DIR="${SNORCAL_DATA_DIR:-$HOME/.snorcal}"

# ----------------------------------------------------------------------------
# Stop + remove service
# ----------------------------------------------------------------------------
if [[ "$PLATFORM" == "mac" ]]; then
  PLIST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
  DOMAIN="gui/$UID/$SERVICE_LABEL"

  if launchctl print "$DOMAIN" >/dev/null 2>&1; then
    log "Stopping LaunchAgent..."
    launchctl bootout "$DOMAIN" 2>/dev/null || warn "bootout failed (service may already be gone)"
    ok "Service stopped"
  else
    warn "Service not loaded."
  fi

  if [[ -f "$PLIST" ]]; then
    rm -f "$PLIST"
    ok "Removed $PLIST"
  else
    warn "No plist at $PLIST"
  fi

else  # linux
  if systemctl --user list-unit-files 2>/dev/null | grep -q '^snorcal\.service'; then
    log "Stopping + disabling systemd --user unit..."
    systemctl --user disable --now snorcal 2>/dev/null || warn "disable --now failed"
    ok "Service disabled + stopped"
  else
    warn "No snorcal.service in --user list."
  fi

  UNIT="$HOME/.config/systemd/user/snorcal.service"
  if [[ -f "$UNIT" ]]; then
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    ok "Removed $UNIT + reloaded daemon"
  else
    warn "No unit at $UNIT"
  fi
fi

# Kill any stray node process still bound to the snorcal port (best-effort).
PORT="${SNORCAL_PORT:-3000}"
if command -v lsof >/dev/null; then
  pids="$(lsof -ti :"$PORT" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    warn "Process still bound to :$PORT — killing: $pids"
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 2
    echo "$pids" | xargs kill -KILL 2>/dev/null || true
  fi
fi

# ----------------------------------------------------------------------------
# Remove install dir
# ----------------------------------------------------------------------------
if [[ "$KEEP_INSTALL" -eq 1 ]]; then
  ok "Keeping install dir (--keep-install): $INSTALL_DIR"
elif [[ -d "$INSTALL_DIR" ]]; then
  log "Removing install dir: $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  ok "Install dir removed"
else
  warn "No install dir at $INSTALL_DIR"
fi

# ----------------------------------------------------------------------------
# Optional purge of data
# ----------------------------------------------------------------------------
if [[ "$PURGE" -eq 1 ]]; then
  if [[ -d "$DATA_DIR" ]]; then
    log "Purging data dir: $DATA_DIR  (DB / models / jobs / logs)"
    printf 'Type "yes" to confirm: '
    read -r confirm
    if [[ "$confirm" == "yes" ]]; then
      rm -rf "$DATA_DIR"
      ok "Data dir purged"
    else
      warn "Confirmation did not match 'yes' — keeping $DATA_DIR"
    fi
  else
    warn "No data dir at $DATA_DIR"
  fi
else
  ok "Keeping data dir (default): $DATA_DIR"
  printf '  Re-run with --purge to also delete DB + models + jobs + logs.\n'
fi

ok "Uninstall complete."
