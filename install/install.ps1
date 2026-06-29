# Snorcal bare-metal installer for Windows.
# Clones the repo, builds, and registers a per-user Scheduled Task that auto-restarts.
#
# Usage (run in PowerShell):
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Optional env overrides:
#   $env:SNORCAL_HOME   = "C:\Users\you\snorcal"   # install dir (default: $USERPROFILE\snorcal)
#   $env:SNORCAL_PORT   = "4000"                    # port (default: 3000)
#
# Re-running on an existing install performs `git pull` + rebuild + task refresh.

#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/davidphillips2/snorcal.git"
$TaskName = "Snorcal"

function Log($msg)    { Write-Host "▶ $msg" -ForegroundColor Cyan }
function Ok($msg)     { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn($msg)   { Write-Host "! $msg" -ForegroundColor Yellow }
function Die($msg)    { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# ----------------------------------------------------------------------------
# Pre-flight: OS + tools
# ----------------------------------------------------------------------------
if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne "Win32NT") {
    Die "This script is for Windows. On macOS/Linux use install.sh."
}
if (-not $IsWindows -and $PSVersionTable.OS -notmatch "Windows") {
    # PowerShell 5.1 doesn't set $IsWindows. On Windows it's effectively always true.
}

Log "Checking prerequisites..."

$git = (Get-Command git.exe    -ErrorAction SilentlyContinue).Source
$node = (Get-Command node.exe  -ErrorAction SilentlyContinue).Source
$pnpm = (Get-Command pnpm.cmd  -ErrorAction SilentlyContinue).Source
if (-not $git)  { Die "git not found. Run: winget install Git.Git" }
if (-not $node) { Die "node not found. Run: winget install OpenJS.NodeJS.LTS" }
if (-not $pnpm) { Die "pnpm not found. Run: winget install pnpm.pnpm  (or: npm install -g pnpm)" }

$nodeMajor = [int](& $node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Die "Node $nodeMajor found, need >=20. Run: winget upgrade OpenJS.NodeJS.LTS" }

Ok "git / node $(& $node -p 'process.versions.node') / pnpm $(& $pnpm --version)"

# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------
$InstallDir = if ($env:SNORCAL_HOME) { $env:SNORCAL_HOME } else { Join-Path $env:USERPROFILE "snorcal" }
$DataDir    = Join-Path $env:USERPROFILE ".snorcal\data"
$LogDir     = Join-Path $env:USERPROFILE ".snorcal\logs"
$Port       = if ($env:SNORCAL_PORT) { $env:SNORCAL_PORT } else { "3000" }

Log "Install dir: $InstallDir"
Log "Data dir:    $DataDir"
Log "Logs dir:    $LogDir"
Log "Port:        $Port"

# ----------------------------------------------------------------------------
# Clone or update
# ----------------------------------------------------------------------------
if (Test-Path (Join-Path $InstallDir ".git")) {
    Log "Existing repo found — pulling latest..."
    & $git -C $InstallDir fetch --quiet origin
    & $git -C $InstallDir reset --hard "@{u}" 2>$null
    if ($LASTEXITCODE -ne 0) { & $git -C $InstallDir pull --ff-only }
} elseif (Test-Path $InstallDir) {
    Die "$InstallDir exists but is not a git repo. Move it aside or set SNORCAL_HOME."
} else {
    Log "Cloning snorcal into $InstallDir..."
    & $git clone --depth 1 $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
}

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
Log "Installing dependencies (pnpm install --frozen-lockfile)..."
Push-Location $InstallDir
try {
    & $pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { Die "pnpm install failed" }

    Log "Building (pnpm build)..."
    & $pnpm build
    if ($LASTEXITCODE -ne 0) { Die "pnpm build failed" }
} finally {
    Pop-Location
}

# ----------------------------------------------------------------------------
# Create runtime dirs
# ----------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir  | Out-Null
Ok "Runtime dirs ready"

# ----------------------------------------------------------------------------
# Render launch wrapper
# ----------------------------------------------------------------------------
$tplSource = Join-Path $InstallDir "install\templates\snorcal-launch.ps1.tpl"
$launcherPath = Join-Path $InstallDir "install\snorcal-launch.ps1"

Log "Rendering launcher → $launcherPath"
$tpl = Get-Content -Raw $tplSource
# Use [regex]::Escape on replacement values so backslashes in Windows paths
# (e.g. C:\Users\...) are not treated as regex group references.
$rendered = $tpl `
    -replace '\$\{INSTALL_DIR\}', [regex]::Escape($InstallDir) `
    -replace '\$\{NODE_BIN\}',    [regex]::Escape($node) `
    -replace '\$\{PORT\}',        $Port
Set-Content -Path $launcherPath -Value $rendered -Encoding UTF8
Ok "Launcher written"

# ----------------------------------------------------------------------------
# Register Scheduled Task
# ----------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# -RunLevel Limited = no elevation. -Force = overwrite if exists (idempotent).
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Description "Snorcal 3D slicing hub (user-level)" `
    -Force | Out-Null
Ok "Scheduled task '$TaskName' registered"

Start-ScheduledTask -TaskName $TaskName

# ----------------------------------------------------------------------------
# Health probe
# ----------------------------------------------------------------------------
Log "Waiting for backend on http://localhost:$Port/api/health ..."
$healthy = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $resp = Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/health" -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}

if ($healthy) {
    Ok "Backend healthy after ${i}s"
    Write-Host ""
    Write-Host "Snorcal running at http://localhost:$Port" -ForegroundColor Green
    Write-Host ""
    PrintHelp
    Start-Process "http://localhost:$Port"
    exit 0
} else {
    Warn "Backend did not become healthy within 30s."
    Log "Last 20 lines of $LogDir\backend.log:"
    if (Test-Path "$LogDir\backend.log") {
        Get-Content "$LogDir\backend.log" -Tail 20
    }
    Log "Task last result:"
    (Get-ScheduledTaskInfo -TaskName $TaskName) | Format-List
    exit 1
}

function PrintHelp {
    Write-Host "Manage snorcal:" -ForegroundColor White
    Write-Host "  status      Get-ScheduledTask -TaskName $TaskName | Format-List; (Get-ScheduledTaskInfo -TaskName $TaskName)"
    Write-Host "  stop        Stop-ScheduledTask -TaskName $TaskName"
    Write-Host "  start       Start-ScheduledTask -TaskName $TaskName"
    Write-Host "  logs        Get-Content `"$LogDir\backend.log`" -Wait -Tail 50"
    Write-Host "  update      powershell -ExecutionPolicy Bypass -File `"$InstallDir\install\install.ps1`""
    Write-Host "  uninstall   Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
    Write-Host ""
}
