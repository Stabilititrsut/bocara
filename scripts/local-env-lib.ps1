# Funciones comunes de los scripts de entorno local de Bocara.
# Se cargan con: . "$PSScriptRoot\local-env-lib.ps1"
# Nunca imprimen valores de variables: solo nombres y estado (OK / FALTA).
# Compatible con Windows PowerShell 5.1. Texto ASCII a proposito (PS 5.1 lee
# los .ps1 sin BOM como ANSI).

$Script:RepoRoot      = Split-Path -Parent $PSScriptRoot
$Script:BackendDir    = Join-Path $RepoRoot 'backend'
$Script:FrontendDir   = Join-Path $RepoRoot 'bocara-mobile'
$Script:BackendEnv    = Join-Path $BackendDir '.env'
$Script:BackendExample = Join-Path $BackendDir '.env.example'
$Script:BackendTemplate = Join-Path $BackendDir '.env.local.template'
# Solo lo carga `expo start` (modo development); `expo export` (build de
# produccion) NO lo lee, asi que nunca termina horneado en un build web.
$Script:FrontendEnv   = Join-Path $FrontendDir '.env.development.local'
$Script:ApiUrlLocal   = 'http://localhost:3000/api'

# Variables sin las cuales el backend no arranca o no hay login.
$Script:VariablesMinimas = @('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET')

# Lee un archivo .env a una tabla { NOMBRE = valor } (sin comentarios).
function Read-DotEnv([string]$Path) {
  $tabla = @{}
  if (-not (Test-Path $Path)) { return $tabla }
  foreach ($linea in [IO.File]::ReadAllLines($Path)) {
    $l = $linea.Trim()
    if ($l -eq '' -or $l.StartsWith('#')) { continue }
    $i = $l.IndexOf('=')
    if ($i -lt 1) { continue }
    $nombre = $l.Substring(0, $i).Trim()
    $valor = $l.Substring($i + 1).Trim()
    if ($valor -match '^"(.*)"$' -or $valor -match "^'(.*)'$") { $valor = $Matches[1] }
    else { $valor = ($valor -replace '\s+#.*$', '').Trim() }
    $tabla[$nombre] = $valor
  }
  return $tabla
}

# Un valor vacio, o identico al de .env.example, no es un valor real.
function Test-ValorReal([hashtable]$Env, [string]$Nombre) {
  if (-not $Env.ContainsKey($Nombre)) { return $false }
  $v = $Env[$Nombre]
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  $ejemplo = Read-DotEnv $Script:BackendExample
  if ($ejemplo.ContainsKey($Nombre) -and $ejemplo[$Nombre] -eq $v) { return $false }
  if ($v -match '^<.*>$' -or $v -match '(?i)^(tu_|your_|xxx|changeme|cambia)') { return $false }
  return $true
}

# Reemplaza (o agrega) NOMBRE=valor en un .env sin tocar el resto del archivo.
function Set-DotEnvValue([string]$Path, [string]$Nombre, [string]$Valor) {
  $lineas = New-Object System.Collections.Generic.List[string]
  if (Test-Path $Path) { $lineas.AddRange([IO.File]::ReadAllLines($Path)) }
  $hecho = $false
  for ($i = 0; $i -lt $lineas.Count; $i++) {
    if ($lineas[$i] -match ('^\s*' + [regex]::Escape($Nombre) + '\s*=')) {
      $lineas[$i] = "$Nombre=$Valor"; $hecho = $true; break
    }
  }
  if (-not $hecho) { $lineas.Add("$Nombre=$Valor") }
  $utf8SinBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllLines($Path, $lineas, $utf8SinBom)
}

function Write-Estado([string]$Etiqueta, [bool]$Ok, [string]$Detalle = '') {
  $texto = if ($Ok) { 'OK' } else { 'FALTA' }
  $color = if ($Ok) { 'Green' } else { 'Red' }
  $linea = ('{0}: {1}' -f $Etiqueta, $texto)
  if ($Detalle) { $linea = "$linea  ($Detalle)" }
  Write-Host $linea -ForegroundColor $color
}

function Test-PuertoOcupado([int]$Puerto) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Puerto -ErrorAction SilentlyContinue)
}
