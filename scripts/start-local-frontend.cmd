@echo off
rem Ejecuta start-local-frontend.ps1 sin cambiar la politica de ejecucion del sistema.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-frontend.ps1" %*
exit /b %ERRORLEVEL%
