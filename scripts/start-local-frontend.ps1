# Arranca la app web de Bocara (Expo) en http://localhost:8082 (o 8083 si 8082
# esta ocupado), apuntando al backend local http://localhost:3000/api.
# La URL sale de bocara-mobile\.env.development.local, que solo lee
# `expo start`: el build de produccion (`expo export`) no la usa.

. "$PSScriptRoot\local-env-lib.ps1"

$envFront = Read-DotEnv $FrontendEnv
if ($envFront['EXPO_PUBLIC_API_URL'] -ne $ApiUrlLocal) {
  Write-Host 'EXPO_PUBLIC_API_URL no apunta al backend local: ejecutando scripts\setup-local-env.ps1...' -ForegroundColor Cyan
  & "$PSScriptRoot\setup-local-env.ps1" | Out-Host
  $envFront = Read-DotEnv $FrontendEnv
}
if ($envFront['EXPO_PUBLIC_API_URL'] -ne $ApiUrlLocal) {
  Write-Host "No se pudo configurar EXPO_PUBLIC_API_URL=$ApiUrlLocal en bocara-mobile\.env.development.local" -ForegroundColor Red
  exit 1
}
Write-Host "FRONTEND API URL: OK ($ApiUrlLocal)" -ForegroundColor Green

# Un EXPO_PUBLIC_API_URL definido en la sesion tiene prioridad sobre el archivo.
if ($env:EXPO_PUBLIC_API_URL -and $env:EXPO_PUBLIC_API_URL -ne $ApiUrlLocal) {
  Write-Host "AVISO: la variable de sesion EXPO_PUBLIC_API_URL apunta a otro lado; se usa la local para este arranque." -ForegroundColor Yellow
}
$env:EXPO_PUBLIC_API_URL = $ApiUrlLocal

if (-not (Test-PuertoOcupado 3000)) {
  Write-Host 'AVISO: el backend local (puerto 3000) no esta corriendo. Arrancalo con scripts\start-local-backend.cmd' -ForegroundColor Yellow
}

$puerto = 8082
if (Test-PuertoOcupado 8082) {
  $puerto = 8083
  if (Test-PuertoOcupado 8083) { Write-Host 'Los puertos 8082 y 8083 estan ocupados.' -ForegroundColor Red; exit 1 }
  Write-Host 'El puerto 8082 esta ocupado: se usa 8083.' -ForegroundColor Yellow
}

Set-Location $FrontendDir
if (-not (Test-Path (Join-Path $FrontendDir 'node_modules\expo'))) {
  Write-Host 'Instalando dependencias del frontend (npm ci)...' -ForegroundColor Cyan
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { Write-Host 'npm ci fallo.' -ForegroundColor Red; exit 1 }
}

Write-Host ''
Write-Host "App web local: http://localhost:$puerto   (Ctrl+C para detener)" -ForegroundColor Green
& npx.cmd expo start --web -c --port $puerto
