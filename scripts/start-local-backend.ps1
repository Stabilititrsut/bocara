# Arranca el backend de Bocara en http://localhost:3000 con backend/.env.
# Valida las variables minimas sin mostrar sus valores. No toca produccion:
# pagos deshabilitados y tareas en segundo plano apagadas (BOCARA_DISABLE_JOBS).

. "$PSScriptRoot\local-env-lib.ps1"

if (-not (Test-Path $BackendEnv) -or -not (Test-Path $FrontendEnv)) {
  Write-Host 'Falta configuracion local: ejecutando scripts\setup-local-env.ps1...' -ForegroundColor Cyan
  & "$PSScriptRoot\setup-local-env.ps1" | Out-Host
}

$envBackend = Read-DotEnv $BackendEnv
$faltan = @($VariablesMinimas | Where-Object { -not (Test-ValorReal $envBackend $_) })
foreach ($v in $VariablesMinimas) { Write-Estado $v (-not ($faltan -contains $v)) }
if ($faltan.Count -gt 0) {
  Write-Host ''
  Write-Host ('No se puede arrancar: falta pegar en backend\.env -> ' + ($faltan -join ', ')) -ForegroundColor Red
  Write-Host 'Abrelo con:  notepad backend\.env   y luego vuelve a ejecutar este script.' -ForegroundColor Yellow
  exit 1
}
if ($envBackend['BOCARA_DISABLE_JOBS'] -ne 'true') {
  Write-Host 'AVISO: BOCARA_DISABLE_JOBS no es true (los crons correran contra la base configurada).' -ForegroundColor Yellow
}
if ($envBackend['CUBO_PAYMENTS_ENABLED'] -eq 'true') {
  Write-Host 'AVISO: CUBO_PAYMENTS_ENABLED=true en local.' -ForegroundColor Yellow
}

if (Test-PuertoOcupado 3000) {
  $pid3000 = (Get-NetTCPConnection -State Listen -LocalPort 3000 | Select-Object -First 1).OwningProcess
  Write-Host "El puerto 3000 ya esta en uso (PID $pid3000). Si es un backend anterior, cierralo o ejecuta scripts\check-local.ps1." -ForegroundColor Red
  exit 1
}

Set-Location $BackendDir
# Las dependencias pueden resolverse desde backend\node_modules o desde el
# node_modules de la raiz del repo; solo se instalan si no hay ninguna.
& node -e "require.resolve('dotenv'); require.resolve('express'); require.resolve('@supabase/supabase-js')" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Instalando dependencias del backend (npm ci)...' -ForegroundColor Cyan
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { Write-Host 'npm ci fallo.' -ForegroundColor Red; exit 1 }
}

Write-Host ''
Write-Host 'Backend local: http://localhost:3000   (Ctrl+C para detener)' -ForegroundColor Green
& npm.cmd start
