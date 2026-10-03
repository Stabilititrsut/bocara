@echo off
rem Ejecuta start-local-backend.ps1 sin cambiar la politica de ejecucion del sistema.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-backend.ps1" %*
exit /b %ERRORLEVEL%
