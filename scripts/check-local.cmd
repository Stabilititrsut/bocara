@echo off
rem Ejecuta check-local.ps1 sin cambiar la politica de ejecucion del sistema.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-local.ps1" %*
exit /b %ERRORLEVEL%
