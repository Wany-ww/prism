@echo off
rem PRISM firewall - allow other PCs to reach the PRISM web/API port (asks for administrator rights)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\firewall.ps1" %*
set PRISM_EXIT=%ERRORLEVEL%
if not "%PRISM_NO_PAUSE%"=="1" pause
exit /b %PRISM_EXIT%
