# Rendered by snorcal install.ps1. Runs the backend in production mode under a
# per-user Scheduled Task. Re-rendered on each install/update run.
$env:NODE_ENV = "production"
$env:PORT = "${PORT}"
$env:HOST = "0.0.0.0"
$env:DATA_DIR = Join-Path $env:USERPROFILE ".snorcal\data"

# Source optional user env file (for SLICER_URL_* overrides etc).
$envFile = Join-Path $env:USERPROFILE ".snorcal\snorcal.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -le 0) { return }
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim().Trim('"')
        Set-Item -Path "env:$k" -Value $v
    }
}

Set-Location "${INSTALL_DIR}\packages\backend"

# Tee to log file. Append so restarts preserve history.
$logDir = Join-Path $env:USERPROFILE ".snorcal\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "backend.log"
& "${NODE_BIN}" dist\index.js 2>&1 | Tee-Object -FilePath $logPath -Append
