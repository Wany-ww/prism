# 로컬 PostgreSQL 실행 — .runtime\pgsql 바이너리 + backend\data\postgres 데이터 (install-postgres.ps1 로 설치)
#   .\scripts\postgres.ps1   : 콘솔 모드로 실행 (Ctrl+C 로 종료), 127.0.0.1:5432
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$postgres = Join-Path $root '.runtime\pgsql\bin\postgres.exe'
$dataDir = Join-Path $root 'backend\data\postgres'
if (-not (Test-Path $postgres) -or -not (Test-Path (Join-Path $dataDir 'PG_VERSION'))) {
    throw 'PostgreSQL 이 설치되지 않았습니다. .\scripts\install-postgres.ps1 을 먼저 실행하세요.'
}
& $postgres -D $dataDir
