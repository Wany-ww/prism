# 로컬 PostgreSQL 설치 (관리자 권한·Windows 서비스 등록 없이 .runtime/ 에 포터블로)
#
#   1) https://www.enterprisedb.com/download-postgresql-binaries 에서 Windows x64 "binaries" zip 을 받아
#      .runtime\downloads\pg\ 에 둔다 (예: postgresql-18.6-1-windows-x64-binaries.zip)
#   2) .\scripts\install-postgres.ps1
#        - .runtime\pgsql 에 압축 해제
#        - backend\data\postgres 에 DB 클러스터 생성 (UTF8, localhost 전용)
#        - prism 계정/DB 생성, 접속 주소와 비밀번호를 backend\.env 에 기록 (git 에 올라가지 않음)
#   3) 기존 SQLite 데이터 이전:  cd backend; ..\.runtime\python\python.exe -m app.migrate_db
#   4) 실행: run.bat (PostgreSQL 과 PRISM 서버를 함께 시작), 중지: stop.bat
#   install.bat 이 이 스크립트를 자동으로 실행한다 (번들에는 .runtime\pgsql 이 이미 풀려 있음)
param(
    [string]$Zip = '',
    [int]$Port = 5432
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pgHome = Join-Path $root '.runtime\pgsql'
$dataDir = Join-Path $root 'backend\data\postgres'
$envFile = Join-Path $root 'backend\.env'

function New-Secret([int]$n = 24) {
    $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] $n
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

# pg_ctl start 가 띄운 서버 프로세스는 표준 출력 핸들을 물려받아 계속 쥐고 있으므로, 출력을 파이프로 받으면
# 스크립트가 끝나지 않는다 → 파일로 받고 pg_ctl 프로세스만 기다린다.
function Invoke-PgCtl([string]$arguments) {
    $out = Join-Path $env:TEMP "prism-pgctl-$([guid]::NewGuid().ToString('N'))"
    $p = Start-Process -FilePath (Join-Path $bin 'pg_ctl.exe') -ArgumentList $arguments -NoNewWindow -PassThru `
        -RedirectStandardOutput "$out.out" -RedirectStandardError "$out.err"
    $null = $p.Handle  # ExitCode 를 읽으려면 필요
    $p.WaitForExit()
    Get-Content "$out.out", "$out.err" -ErrorAction SilentlyContinue | Out-Host
    return $p.ExitCode
}

function Set-EnvLine([string]$key, [string]$value) {
    $lines = @()
    if (Test-Path $envFile) { $lines = @(Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -notmatch "^\s*$key\s*=" }) }
    $lines += "$key=$value"
    [System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

# 1) 바이너리
if (-not (Test-Path (Join-Path $pgHome 'bin\postgres.exe'))) {
    if (-not $Zip) {
        $Zip = Get-ChildItem (Join-Path $root '.runtime\downloads\pg') -Filter 'postgresql-*-windows-x64-binaries.zip' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $Zip -or -not (Test-Path $Zip)) { throw 'PostgreSQL binaries zip 이 없습니다. 위 1) 을 참고하세요.' }
    Write-Host "Extracting $(Split-Path $Zip -Leaf) ..."
    $tmp = Join-Path $root '.runtime\pgsql-extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory $tmp | Out-Null
    tar -xf $Zip -C $tmp
    if ($LASTEXITCODE -ne 0) { throw 'Extraction failed' }
    Move-Item (Join-Path $tmp 'pgsql') $pgHome
    Remove-Item $tmp -Recurse -Force
}
$bin = Join-Path $pgHome 'bin'
& (Join-Path $bin 'postgres.exe') --version

# 2) 클러스터
if (Test-Path (Join-Path $dataDir 'PG_VERSION')) {
    Write-Host "Cluster already exists at $dataDir — leaving it and backend\.env as they are."
    exit 0
}
$adminPw = New-Secret
$appPw = New-Secret
$pwFile = Join-Path $env:TEMP "prism-pg-$([guid]::NewGuid().ToString('N')).txt"
try {
    [System.IO.File]::WriteAllText($pwFile, $adminPw)
    & (Join-Path $bin 'initdb.exe') -D $dataDir -U postgres --pwfile=$pwFile -E UTF8 --locale=C -A scram-sha-256 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
} finally {
    Remove-Item $pwFile -ErrorAction SilentlyContinue
}
@"

# --- PRISM ---
listen_addresses = 'localhost'
port = $Port
max_connections = 200
shared_buffers = 256MB
"@ | Add-Content (Join-Path $dataDir 'postgresql.conf') -Encoding ASCII

# 3) 계정/DB
$log = Join-Path $dataDir 'install.log'
if ((Invoke-PgCtl "-D `"$dataDir`" -l `"$log`" -w start") -ne 0) { throw "PostgreSQL did not start — see $log" }
try {
    $env:PGPASSWORD = $adminPw
    $psql = Join-Path $bin 'psql.exe'
    & $psql -h 127.0.0.1 -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE ROLE prism LOGIN PASSWORD '$appPw'" -c 'CREATE DATABASE prism OWNER prism'
    if ($LASTEXITCODE -ne 0) { throw 'Creating the prism role/database failed' }
} finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    $null = Invoke-PgCtl "-D `"$dataDir`" -w stop"
}

# 4) 접속 정보 → backend/.env
Set-EnvLine 'PRISM_DATABASE_URL' "postgresql+psycopg://prism:$appPw@127.0.0.1:$Port/prism"
Set-EnvLine 'PRISM_PG_ADMIN_PASSWORD' $adminPw
Write-Host ''
Write-Host "PostgreSQL ready: data in backend\data\postgres, connection saved to backend\.env"
Write-Host 'run.bat / stop.bat 이 함께 켜고 끕니다. 기존 SQLite 데이터 이전: cd backend; ..\.runtime\python\python.exe -m app.migrate_db'
