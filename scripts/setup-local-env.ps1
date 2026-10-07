# Prepara el entorno local de Bocara sin imprimir ningun secreto.
#
#   backend/.env
#     - Si no existe, o es una copia sin editar de .env.example, se crea desde
#       backend/.env.local.template.
#     - Si ya tiene valores reales, NO se pisan: solo se completan los que faltan.
#     - SUPABASE_URL: se toma de bocara-mobile/src/services/supabase.ts (publica).
#     - JWT_SECRET: se genera uno aleatorio local si falta.
#     - SUPABASE_SERVICE_KEY: no se puede obtener automaticamente; hay que pegarla.
#   bocara-mobile/.env.development.local
#     - EXPO_PUBLIC_API_URL=http://localhost:3000/api (solo para `expo start`).
#
# Idempotente: se puede correr las veces que haga falta.

. "$PSScriptRoot\local-env-lib.ps1"
$ErrorActionPreference = 'Stop'

Write-Host '== Backend: backend/.env ==' -ForegroundColor Cyan

$copiaDelEjemplo = (Test-Path $BackendEnv) -and (Test-Path $BackendExample) -and
  ((Get-FileHash $BackendEnv).Hash -eq (Get-FileHash $BackendExample).Hash)

if (-not (Test-Path $BackendEnv) -or $copiaDelEjemplo) {
  if ($copiaDelEjemplo) { Write-Host 'backend/.env es una copia sin editar de .env.example (sin secretos): se reemplaza por la plantilla local.' }
  else { Write-Host 'backend/.env no existe: se crea desde backend/.env.local.template.' }
  Copy-Item $BackendTemplate $BackendEnv -Force
} else {
  Write-Host 'backend/.env ya existe con contenido propio: solo se completan las variables que falten.'
}

$envActual = Read-DotEnv $BackendEnv

# SUPABASE_URL: publica, ya incluida en la app.
if (-not (Test-ValorReal $envActual 'SUPABASE_URL')) {
  $fuente = Join-Path $FrontendDir 'src\services\supabase.ts'
  $m = Select-String -Path $fuente -Pattern "supabaseUrl\s*=\s*'(https://[a-z0-9]+\.supabase\.co)'" | Select-Object -First 1
  if ($m) {
    Set-DotEnvValue $BackendEnv 'SUPABASE_URL' $m.Matches[0].Groups[1].Value
    Write-Host 'SUPABASE_URL: completada desde la configuracion publica de la app.' -ForegroundColor Green
  } else {
    Write-Host 'SUPABASE_URL: no se encontro en la app; hay que pegarla a mano.' -ForegroundColor Yellow
  }
}

# JWT_SECRET: local y aleatorio (el backend local firma y valida sus propios tokens).
if (-not (Test-ValorReal $envActual 'JWT_SECRET')) {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secreto = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Set-DotEnvValue $BackendEnv 'JWT_SECRET' $secreto
  Write-Host 'JWT_SECRET: generado localmente (aleatorio, no se muestra).' -ForegroundColor Green
}

# Seguridad local: sin tareas en segundo plano ni pagos.
$envActual = Read-DotEnv $BackendEnv
foreach ($par in @(@('BOCARA_DISABLE_JOBS', 'true'), @('CUBO_PAYMENTS_ENABLED', 'false'), @('NODE_ENV', 'development'), @('PORT', '3000'))) {
  if (-not $envActual.ContainsKey($par[0]) -or [string]::IsNullOrWhiteSpace($envActual[$par[0]])) {
    Set-DotEnvValue $BackendEnv $par[0] $par[1]
  }
}
$envActual = Read-DotEnv $BackendEnv
if ($envActual['BOCARA_DISABLE_JOBS'] -ne 'true') {
  Write-Host 'AVISO: BOCARA_DISABLE_JOBS no es true: este backend correra los crons contra la base configurada.' -ForegroundColor Yellow
}
if ($envActual['CUBO_PAYMENTS_ENABLED'] -eq 'true') {
  Write-Host 'AVISO: CUBO_PAYMENTS_ENABLED=true en local. Para estas pruebas deberia ser false.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '== Frontend: bocara-mobile/.env.development.local ==' -ForegroundColor Cyan
$envFront = Read-DotEnv $FrontendEnv
if ($envFront['EXPO_PUBLIC_API_URL'] -ne $ApiUrlLocal) {
  Set-DotEnvValue $FrontendEnv 'EXPO_PUBLIC_API_URL' $ApiUrlLocal
  Write-Host "EXPO_PUBLIC_API_URL=$ApiUrlLocal (solo modo desarrollo; el build de produccion no lo lee)." -ForegroundColor Green
} else {
  Write-Host 'EXPO_PUBLIC_API_URL ya apunta al backend local.' -ForegroundColor Green
}

Write-Host ''
Write-Host '== Estado ==' -ForegroundColor Cyan
$envActual = Read-DotEnv $BackendEnv
$faltan = @()
foreach ($v in $VariablesMinimas) {
  $ok = Test-ValorReal $envActual $v
  Write-Estado $v $ok
  if (-not $ok) { $faltan += $v }
}
if ($faltan.Count -gt 0) {
  Write-Host ''
  Write-Host 'FALTA PEGAR en backend\.env (abrelo con: notepad backend\.env):' -ForegroundColor Yellow
  foreach ($v in $faltan) { Write-Host "  $v=<valor>" -ForegroundColor Yellow }
  if ($faltan -contains 'SUPABASE_SERVICE_KEY') {
    Write-Host '  SUPABASE_SERVICE_KEY: Supabase Dashboard > Project Settings > API > service_role.' -ForegroundColor Yellow
  }
  exit 1
}
Write-Host 'Entorno local listo.' -ForegroundColor Green
