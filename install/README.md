# Bare-metal install (Windows / macOS / Linux)

User-level installers that clone snorcal, build it, and register a self-restarting
service. **No admin / sudo required.** For container deployment see `../docker/` instead.

## Prerequisites

Install these yourself (installer checks and will warn if missing):

- **git**
- **Node.js ≥ 20** — <https://nodejs.org/>
- **pnpm** — `npm install -g pnpm` (or `winget install pnpm.pnpm` on Windows)
- **Slicer apps** (for local slicing) — install OrcaSlicer and/or BambuStudio to their default locations. The installer does NOT download slicer binaries. See app settings UI inside snorcal to verify which engines are detected.

| OS | One-liner |
|---|---|
| **macOS / Linux** | `bash <(curl -fsSL https://raw.githubusercontent.com/davidphillips2/snorcal/main/install/install.sh)` |
| **Windows (PowerShell)** | `iex (irm https://raw.githubusercontent.com/davidphillips2/snorcal/main/install/install.ps1)` |

> If you prefer to clone first: `git clone https://github.com/davidphillips2/snorcal.git` then run the installer for your OS from inside the repo.

## Environment overrides

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `SNORCAL_HOME` | `~/snorcal` (mac/linux) or `%USERPROFILE%\snorcal` (win) | Install / clone location |
| `SNORCAL_PORT` | `3000` | Backend listen port |
| `SNORCAL_DATA_DIR` | `~/.snorcal/data` (mac/linux only — Windows always `%USERPROFILE%\.snorcal\data`) | SQLite DB, models, jobs |
| `SNORCAL_LOG_DIR` | `~/.snorcal/logs` (mac/linux) | Log output location |

## Default paths

| | Install dir | Data dir | Logs | Service definition |
|---|---|---|---|---|
| **mac** | `~/snorcal` | `~/.snorcal/data` | `~/.snorcal/logs/backend.{out,err}.log` | `~/Library/LaunchAgents/com.snorcal.backend.plist` |
| **linux** | `~/snorcal` | `~/.snorcal/data` | `~/.snorcal/logs/backend.log` + `journalctl --user -u snorcal` | `~/.config/systemd/user/snorcal.service` |
| **windows** | `%USERPROFILE%\snorcal` | `%USERPROFILE%\.snorcal\data` | `%USERPROFILE%\.snorcal\logs\backend.log` | Scheduled Task named `Snorcal` |

## Uninstall

Automated scripts stop the service, remove its definition, and (by default) delete
the install dir. The data dir (`~/.snorcal` / `%USERPROFILE%\.snorcal` — DB,
models, jobs, logs) is **kept by default** to prevent accidental loss.

| OS | Command |
|---|---|
| **mac / linux** | `bash ~/snorcal/install/uninstall.sh` |
| **windows** | `powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\snorcal\install\uninstall.ps1"` |

Flags (same on both):

| Flag | Effect |
|---|---|
| (default) | stop service + remove service unit + remove install dir, **keep data dir** |
| `--keep-install` (sh) / `-KeepInstall` (ps1) | stop service + remove service unit only — leave install dir intact |
| `--purge` (sh) / `-Purge` (ps1) | also delete `~/.snorcal` / `%USERPROFILE%\.snorcal` (prompts for "yes" confirmation) |

If the install dir is already gone, fetch the script raw from GitHub:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/davidphillips2/snorcal/main/install/uninstall.sh)
```

```powershell
iex (irm https://raw.githubusercontent.com/davidphillips2/snorcal/main/install/uninstall.ps1)
```

## Managing the service

### macOS (launchd)

```bash
# status
launchctl print gui/$(id -u)/com.snorcal.backend | head -30

# stop / start / restart
launchctl kill TERM gui/$(id -u)/com.snorcal.backend
launchctl kickstart -k gui/$(id -u)/com.snorcal.backend

# logs
tail -f ~/.snorcal/logs/backend.err.log

# update (re-run installer — it pulls, rebuilds, re-registers)
bash ~/snorcal/install/install.sh

# uninstall
launchctl bootout gui/$(id -u)/com.snorcal.backend
rm ~/Library/LaunchAgents/com.snorcal.backend.plist
```

### Linux (systemd --user)

```bash
systemctl --user status snorcal
systemctl --user stop snorcal
systemctl --user start snorcal
systemctl --user restart snorcal

# logs
journalctl --user -u snorcal -f

# update
bash ~/snorcal/install/install.sh

# uninstall
systemctl --user disable --now snorcal
rm ~/.config/systemd/user/snorcal.service
systemctl --user daemon-reload
```

If `loginctl enable-linger` failed during install, the service stops when you log
out. Re-run with admin (`sudo loginctl enable-linger $USER`) to keep it running
across logout.

### Windows (Scheduled Task)

```powershell
# status
Get-ScheduledTask -TaskName Snorcal | Format-List
Get-ScheduledTaskInfo -TaskName Snorcal

# stop / start
Stop-ScheduledTask -TaskName Snorcal
Start-ScheduledTask -TaskName Snorcal

# logs
Get-Content "$env:USERPROFILE\.snorcal\logs\backend.log" -Wait -Tail 50

# update
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\snorcal\install\install.ps1"

# uninstall
Unregister-ScheduledTask -TaskName Snorcal -Confirm:$false
```

## Slicer sidecars (optional)

By default a bare-metal snorcal install talks to **local slicer binaries** (the
OrcaSlicer.app / BambuStudio.app you installed). No sidecar containers required.

To use remote bambuddy sidecars instead, create a user env file:

| OS | File | Effect |
|---|---|---|
| mac / linux | `~/.snorcal/snorcal.env` | sourced by launcher before `node` exec |
| windows | `%USERPROFILE%\.snorcal\snorcal.env` | parsed by `snorcal-launch.ps1` |

Contents (example):

```
SLICER_URL_ORCASLICER=http://hilltopnas:3003
SLICER_URL_BAMBUSTUDIO=http://hilltopnas:3001
```

Restart the service after editing.

## Caveats

- **User-level only.** Service runs under your account. It starts at logon and
  restarts on crash (mac KeepAlive, linux Restart=on-failure, win RestartCount 3).
  It does NOT run while you are logged out unless you enable lingering (linux)
  or switch to a system-level service (out of scope here — see plan file).
- **better-sqlite3 native build.** If pnpm install fails on linux with a
  compiler error, install build-essential / make / g++ and re-run.
- **Port 3000 conflict.** Override with `SNORCAL_PORT=xxxx`.
- **Reverse proxy.** The service listens on `0.0.0.0:3000` (HTTP). Put your own
  nginx / Caddy / Traefik in front for HTTPS or auth.
