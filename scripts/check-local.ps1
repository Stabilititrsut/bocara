# Diagnostico del entorno local de Bocara. No imprime ningun secreto.
# Salida: una linea OK/FALTA por comprobacion y "LOCAL ENV READY: YES/NO".

. "$PSScriptRoot\local-env-lib.ps1"
$todoOk = $true
function Marcar([string]$Etiqueta, [bool]$Ok, [string]$Detalle = '') {
  Write-Estado $Etiqueta $Ok $Detalle
  if (-not $Ok) { $Script:todoOk = $false }
}
function Pedir([string]$Url, [hashtable]$Headers = @{}) {
  try { return Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -TimeoutSec 20 }
  catch { if ($_.Exception.Response) { return $_.Exception.Response } else { return $null } }
}

# -- Configuracion --
$existeEnv = Test-Path $BackendEnv
Marcar 'BACKEND ENV' $existeEnv $(if ($existeEnv) { 'backend\.env' } else { 'ejecuta scripts\setup-local-env.cmd' })
$envBackend = Read-DotEnv $BackendEnv
$supabaseVars = (Test-ValorReal $envBackend 'SUPABASE_URL') -and (Test-ValorReal $envBackend 'SUPABASE_SERVICE_KEY')
$jwtOk = Test-ValorReal $envBackend 'JWT_SECRET'
Marcar 'JWT' $jwtOk
Write-Estado 'JOBS EN SEGUNDO PLANO DESACTIVADOS' ($envBackend['BOCARA_DISABLE_JOBS'] -eq 'true') 'BOCARA_DISABLE_JOBS'
Write-Estado 'PAGOS DESHABILITADOS' ($envBackend['CUBO_PAYMENTS_ENABLED'] -ne 'true') 'CUBO_PAYMENTS_ENABLED'

$envFront = Read-DotEnv $FrontendEnv
Marcar 'FRONTEND API URL' ($envFront['EXPO_PUBLIC_API_URL'] -eq $ApiUrlLocal) $ApiUrlLocal

# -- Backend en marcha --
$puertoAbierto = Test-PuertoOcupado 3000
$raiz = if ($puertoAbierto) { Pedir 'http://localhost:3000/' } else { $null }
$backendOk = $raiz -and [int]$raiz.StatusCode -eq 200
Marcar 'BACKEND PORT 3000' $backendOk $(if (-not $puertoAbierto) { 'no esta corriendo: scripts\start-local-backend.cmd' } elseif (-not $backendOk) { 'responde con error' } else { 'http://localhost:3000' })

# SUPABASE: variables presentes y, si el backend corre, una consulta real
# (GET /api/negocios/feed es publico y de solo lectura).
if (-not $supabaseVars) {
  Marcar 'SUPABASE' $false 'falta SUPABASE_URL o SUPABASE_SERVICE_KEY en backend\.env'
} elseif ($backendOk) {
  $feed = Pedir 'http://localhost:3000/api/negocios/feed'
  $feedOk = $feed -and [int]$feed.StatusCode -eq 200
  Marcar 'SUPABASE' $feedOk $(if ($feedOk) { 'consulta de lectura OK' } else { 'el backend no pudo consultar Supabase (revisa SUPABASE_SERVICE_KEY)' })
} else {
  Marcar 'SUPABASE' $true 'variables presentes (sin backend en marcha no se probo la conexion)'
}

# CORS: el navegador en localhost:8082 debe poder llamar al backend.
if ($backendOk) {
  $cors = Pedir 'http://localhost:3000/api/negocios/feed' @{ Origin = 'http://localhost:8082' }
  $acao = if ($cors) { $cors.Headers['Access-Control-Allow-Origin'] } else { $null }
  Marcar 'CORS localhost:8082' ($acao -eq 'http://localhost:8082')
}

# -- Frontend en marcha (informativo) --
$front = @(8082, 8083) | Where-Object { Test-PuertoOcupado $_ } | Select-Object -First 1
if ($front) { Write-Host "FRONTEND WEB: corriendo en http://localhost:$front" -ForegroundColor Green }
else { Write-Host 'FRONTEND WEB: no esta corriendo (scripts\start-local-frontend.cmd)' -ForegroundColor Yellow }

Write-Host ''
if ($todoOk) { Write-Host 'LOCAL ENV READY: YES' -ForegroundColor Green; exit 0 }
Write-Host 'LOCAL ENV READY: NO' -ForegroundColor Red
exit 1
