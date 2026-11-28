# PRISM 개발용 실행 (이 창에서 실행, Ctrl+C 로 종료)
#   운영/폐쇄망 서버는 install.bat (처음 한 번) → run.bat / stop.bat 을 사용한다.
#   .\start.ps1           : 화면·Rust 엔진 소스가 빌드보다 새로우면 다시 빌드한 뒤 실행
#   .\start.ps1 -Rebuild  : 화면 다시 빌드
param([switch]$Rebuild, [int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$dist = Join-Path $root 'frontend\dist\index.html'
# 화면 소스가 마지막 빌드보다 새로우면 다시 빌드 (예전 화면이 그대로 보이는 것 방지)
$stale = (Test-Path $dist) -and (Get-ChildItem (Join-Path $root 'frontend\src') -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Item $dist).LastWriteTime } | Select-Object -First 1)
$hasNpm = [bool](Get-Command npm -ErrorAction SilentlyContinue)
if ($Rebuild -or -not (Test-Path $dist)) {
    if (-not $hasNpm) { throw 'frontend\dist 가 없고 npm 도 없습니다. 배포 폴더(scripts\build-bundle.ps1)를 사용하세요.' }
    Push-Location (Join-Path $root 'frontend')
    try { if (-not (Test-Path node_modules)) { npm ci }; npm run build } finally { Pop-Location }
} elseif ($stale) {
    if ($hasNpm -and (Test-Path (Join-Path $root 'frontend\node_modules'))) {
        Push-Location (Join-Path $root 'frontend'); try { npm run build } finally { Pop-Location }
    } else {
        Write-Warning '화면 소스가 빌드보다 새롭지만 npm/node_modules 가 없어 기존 frontend\dist 로 실행합니다.'
    }
}

# Rust 엔진 소스가 빌드보다 새로우면 다시 빌드 (cargo 가 있을 때)
$pyd = Join-Path $root 'backend\app\prism_core.pyd'
$rs = Get-ChildItem (Join-Path $root 'native') -Recurse -File -Include *.rs, Cargo.toml -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\target\\' }
if ((-not (Test-Path $pyd) -or ($rs | Where-Object { $_.LastWriteTime -gt (Get-Item $pyd).LastWriteTime } | Select-Object -First 1)) -and (Get-Command cargo -ErrorAction SilentlyContinue)) {
    & (Join-Path $root 'scripts\build-native.ps1')
}

& (Join-Path $root 'scripts\run.ps1') -Foreground -Port $Port
