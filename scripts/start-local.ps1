# Levanta backend y frontend en dos ventanas de PowerShell separadas.
# Cada ventana corre su propio script (y valida su configuracion).

. "$PSScriptRoot\local-env-lib.ps1"

& "$PSScriptRoot\setup-local-env.ps1" | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Completa backend\.env y vuelve a ejecutar scripts\start-local.cmd' -ForegroundColor Red
  exit 1
}

$psExe = (Get-Process -Id $PID).Path
foreach ($script in @('start-local-backend.ps1', 'start-local-frontend.ps1')) {
  Start-Process -FilePath $psExe -WorkingDirectory $RepoRoot -ArgumentList @(
    '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot $script)
  )
  Start-Sleep -Seconds 2
}

Write-Host ''
Write-Host 'Se abrieron dos ventanas: backend (http://localhost:3000) y frontend (http://localhost:8082).' -ForegroundColor Green
Write-Host 'Cuando ambas terminen de arrancar: scripts\check-local.cmd' -ForegroundColor Green
