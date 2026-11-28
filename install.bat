@echo off
rem PRISM install - one-time setup: bundled Python/PostgreSQL, database, settings import (offline)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set PRISM_EXIT=%ERRORLEVEL%
if not "%PRISM_NO_PAUSE%"=="1" pause
exit /b %PRISM_EXIT%
