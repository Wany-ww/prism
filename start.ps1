# PRISM 실행 스크립트 (Windows PowerShell)
#   .\start.ps1           : 최초 실행 시 의존성 설치 + 프론트 빌드 후 http://<서버>:8000 으로 서비스
#   .\start.ps1 -Rebuild  : 프론트엔드 다시 빌드
param([switch]$Rebuild, [int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$py = Join-Path $root 'backend\.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    python -m venv (Join-Path $root 'backend\.venv')
    & $py -m pip install -r (Join-Path $root 'backend\requirements.txt')
}

$dist = Join-Path $root 'frontend\dist\index.html'
if ($Rebuild -or -not (Test-Path $dist)) {
    Push-Location (Join-Path $root 'frontend')
    npm install
    npm run build
    Pop-Location
}

& $py -m uvicorn app.main:app --app-dir (Join-Path $root 'backend') --host 0.0.0.0 --port $Port
