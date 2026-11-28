@echo off
rem PRISM run - start PostgreSQL, Neo4j (if installed) and the PRISM server in the background
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run.ps1" %*
set PRISM_EXIT=%ERRORLEVEL%
if not "%PRISM_NO_PAUSE%"=="1" pause
exit /b %PRISM_EXIT%
