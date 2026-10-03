@echo off
rem Ejecuta setup-local-env.ps1 sin cambiar la politica de ejecucion del sistema.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-local-env.ps1" %*
exit /b %ERRORLEVEL%
