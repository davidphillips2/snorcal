# Snorcal bare-metal uninstaller for Windows.
#
# Stops the Scheduled Task, unregisters it, optionally deletes the install dir
# and (with -Purge) the data dir (DB / models / jobs).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepInstall
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
#
# Re-run safely even if the task is already gone.

#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$KeepInstall,
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$TaskName = "Snorcal"

function Log($msg)  { Write-Host "? $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "? $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "? $msg" -ForegroundColor Red; exit 1 }

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne "Win32NT") {
    Die "This script is for Windows. On macOS/Linux use uninstall.sh."
}

$InstallDir = if ($env:SNORCAL_HOME) { $env:SNORCAL_HOME } else { Join-Path $env:USERPROFILE "snorcal" }
$DataDir    = Join-Path $env:USERPROFILE ".snorcal"
$Port       = if ($env:SNORCAL_PORT) { $env:SNORCAL_PORT } else { "3000" }

# ----------------------------------------------------------------------------
# Stop + unregister Scheduled Task
# ----------------------------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Log "Stopping Scheduled Task '$TaskName'..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Log "Unregistering..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "Scheduled task removed"
} else {
    Warn "No scheduled task named '$TaskName' found."
}

# Kill any stray node bound to the snorcal port (best-effort).
try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            try {
                $p = Get-Process -Id $c.OwningProcess -ErrorAction Stop
                Warn "Killing process on :$Port -> PID $($p.Id) ($($p.Name))"
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            } catch { }
        }
    }
} catch { }

# ----------------------------------------------------------------------------
# Remove install dir
# ----------------------------------------------------------------------------
if ($KeepInstall) {
    Ok "Keeping install dir (-KeepInstall): $InstallDir"
} elseif (Test-Path $InstallDir) {
    Log "Removing install dir: $InstallDir"
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) {
        Warn "Failed to fully remove $InstallDir (may be in use). Close editors/explorers and re-run."
    } else {
        Ok "Install dir removed"
    }
} else {
    Warn "No install dir at $InstallDir"
}

# ----------------------------------------------------------------------------
# Optional purge of data
# ----------------------------------------------------------------------------
if ($Purge) {
    if (Test-Path $DataDir) {
        Log "Purging data dir: $DataDir  (DB / models / jobs / logs)"
        $confirm = Read-Host 'Type "yes" to confirm'
        if ($confirm -eq "yes") {
            Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
            if (Test-Path $DataDir) {
                Warn "Failed to fully remove $DataDir (files may be locked)."
            } else {
                Ok "Data dir purged"
            }
        } else {
            Warn 'Confirmation did not match "yes" - keeping $DataDir'
        }
    } else {
        Warn "No data dir at $DataDir"
    }
} else {
    Ok "Keeping data dir (default): $DataDir"
    Write-Host "  Re-run with -Purge to also delete DB + models + jobs + logs."
}

Ok "Uninstall complete."
