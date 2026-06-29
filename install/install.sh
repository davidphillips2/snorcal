#!/usr/bin/env bash
# Snorcal bare-metal installer for macOS + Linux.
# Clones the repo, builds, and registers a user-level service that auto-restarts.
#
# Usage:
#   bash install.sh                # install / update to ~/snorcal
#   SNORCAL_HOME=/opt/snorcal SNORCAL_PORT=4000 bash install.sh
#
# Re-running on an existing install performs `git pull` + rebuild + service refresh.
set -euo pipefail

REPO_URL="https://github.com/davidphillips2/snorcal.git"
SERVICE_LABEL="com.snorcal.backend"

log()   { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

print_help() {
  cat <<EOF
\033[1mManage snorcal:\033[0m
EOF
  if [[ "$PLATFORM" == "mac" ]]; then
    cat <<'EOF'
  status      launchctl print gui/$UID/com.snorcal.backend | head -30
  stop        launchctl kill TERM gui/$UID/com.snorcal.backend
  start       launchctl kickstart -k gui/$UID/com.snorcal.backend
  logs        tail -f ~/.snorcal/logs/backend.err.log
  update      bash ~/snorcal/install/install.sh   # re-run installer = pull + rebuild + restart
  uninstall   launchctl bootout gui/$UID/com.snorcal.backend && rm ~/Library/LaunchAgents/com.snorcal.backend.plist
EOF
  else
    cat <<'EOF'
  status      systemctl --user status snorcal
  stop        systemctl --user stop snorcal
  start       systemctl --user start snorcal
  logs        journalctl --user -u snorcal -f
  update      bash ~/snorcal/install/install.sh   # re-run installer = pull + rebuild + restart
  uninstall   systemctl --user disable --now snorcal && rm ~/.config/systemd/user/snorcal.service
EOF
  fi
  printf '\n'
}

# ----------------------------------------------------------------------------
# Detect OS
# ----------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *)      die "Unsupported OS: $OS. On Windows use install.ps1." ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_NORM="x64" ;;
  arm64|aarch64) ARCH_NORM="arm64" ;;
  *) die "Unsupported architecture: $ARCH (need x64 or arm64)" ;;
esac

# ----------------------------------------------------------------------------
# Pre-flight: tools
# ----------------------------------------------------------------------------
log "Checking prerequisites on $PLATFORM ($ARCH_NORM)..."

command -v git >/dev/null   || die "git not found. $([[ $PLATFORM == mac ]] && echo 'Run: brew install git' || echo 'Run: sudo apt install -y git  (or: sudo dnf install -y git)')"
command -v node >/dev/null  || die "node not found. $([[ $PLATFORM == mac ]] && echo 'Run: brew install node' || echo 'See https://nodejs.org/en/download/ or your distro packages')"
command -v pnpm >/dev/null  || die "pnpm not found. Run: npm install -g pnpm  (or: $([[ $PLATFORM == mac ]] && echo 'brew install pnpm' || echo 'sudo npm install -g pnpm'))"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node $NODE_MAJOR found, need >=20. Upgrade: https://nodejs.org/"

NODE_BIN="$(command -v node)"
ok "git / node $(node -p 'process.versions.node') / pnpm $(pnpm --version)"

# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------
INSTALL_DIR="${SNORCAL_HOME:-$HOME/snorcal}"
DATA_DIR="${SNORCAL_DATA_DIR:-$HOME/.snorcal/data}"
LOG_DIR="${SNORCAL_LOG_DIR:-$HOME/.snorcal/logs}"
PORT="${SNORCAL_PORT:-3000}"
PATH_ENV="$PATH"

# Ensure $HOME is set (systemd --user context can be sparse).
[[ -n "${HOME:-}" ]] || die "HOME is not set."

log "Install dir: $INSTALL_DIR"
log "Data dir:    $DATA_DIR"
log "Logs dir:    $LOG_DIR"
log "Port:        $PORT"

# ----------------------------------------------------------------------------
# Clone or update
# ----------------------------------------------------------------------------
if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "Existing repo found — pulling latest..."
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --hard --quiet "@{u}" 2>/dev/null || git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  die "$INSTALL_DIR exists but is not a git repo. Move it aside or set SNORCAL_HOME."
else
  log "Cloning snorcal into $INSTALL_DIR..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
log "Installing dependencies (pnpm install --frozen-lockfile)..."
( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile )

log "Building (pnpm build)..."
( cd "$INSTALL_DIR" && pnpm build )

# ----------------------------------------------------------------------------
# Create runtime dirs
# ----------------------------------------------------------------------------
mkdir -p "$DATA_DIR" "$LOG_DIR"
mkdir -p "$HOME/.snorcal"
ok "Runtime dirs ready"

# ----------------------------------------------------------------------------
# Render + register service
# ----------------------------------------------------------------------------
TEMPLATE_DIR="$INSTALL_DIR/install/templates"

render() {
  # $1 = template path, $2 = output path
  sed \
    -e "s|\${INSTALL_DIR}|$INSTALL_DIR|g" \
    -e "s|\${NODE_BIN}|$NODE_BIN|g" \
    -e "s|\${DATA_DIR}|$DATA_DIR|g" \
    -e "s|\${LOG_DIR}|$LOG_DIR|g" \
    -e "s|\${PORT}|$PORT|g" \
    -e "s|\${PATH_ENV}|$PATH_ENV|g" \
    "$1" > "$2"
}

if [[ "$PLATFORM" == "mac" ]]; then
  PLIST_SRC="$TEMPLATE_DIR/com.snorcal.backend.plist.tpl"
  PLIST_DST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
  mkdir -p "$(dirname "$PLIST_DST")"

  log "Rendering LaunchAgent → $PLIST_DST"
  render "$PLIST_SRC" "$PLIST_DST"

  # Unload existing (best-effort) then load fresh.
  launchctl bootout "gui/$UID/$SERVICE_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST_DST"
  launchctl enable "gui/$UID/$SERVICE_LABEL"
  launchctl kickstart -k "gui/$UID/$SERVICE_LABEL"
  ok "LaunchAgent registered and started"

elif [[ "$PLATFORM" == "linux" ]]; then
  UNIT_SRC="$TEMPLATE_DIR/snorcal.service.tpl"
  UNIT_DST="$HOME/.config/systemd/user/snorcal.service"
  mkdir -p "$(dirname "$UNIT_DST")"

  log "Rendering systemd unit → $UNIT_DST"
  render "$UNIT_SRC" "$UNIT_DST"

  # enable-linger keeps the user manager alive after logout. May require admin
  # on some distros — warn (not fatal) if it fails.
  if ! loginctl enable-linger "$USER" 2>/dev/null; then
    warn "loginctl enable-linger failed — service will stop when you log out."
    warn "  Run manually with sudo if you want it to persist: sudo loginctl enable-linger $USER"
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now snorcal
  ok "systemd --user unit registered and started"
fi

# ----------------------------------------------------------------------------
# Health probe
# ----------------------------------------------------------------------------
log "Waiting for backend on http://localhost:$PORT/api/health ..."
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    ok "Backend healthy after ${i}s"
    printf '\n\033[1;32mSnorcal running at http://localhost:%s\033[0m\n\n' "$PORT"
    print_help
    exit 0
  fi
  sleep 1
done

warn "Backend did not become healthy within 30s."
if [[ "$PLATFORM" == "mac" ]]; then
  log "Last 20 lines of $LOG_DIR/backend.err.log:"
  tail -n 20 "$LOG_DIR/backend.err.log" 2>/dev/null || true
  log "Service status:"
  launchctl print "gui/$UID/$SERVICE_LABEL" 2>&1 | head -40 || true
else
  log "Last 20 lines of journal:"
  journalctl --user -u snorcal -n 20 --no-pager || true
fi
exit 1
