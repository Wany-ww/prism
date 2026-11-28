@echo off
rem PRISM stop - stop the PRISM server, Neo4j and PostgreSQL
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" %*
set PRISM_EXIT=%ERRORLEVEL%
if not "%PRISM_NO_PAUSE%"=="1" pause
exit /b %PRISM_EXIT%
