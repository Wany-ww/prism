# PRISM 설치 (install.bat) — 한 번 실행하면 이 PC 에서 바로 쓸 수 있게 준비한다. 다시 실행해도 안전하다.
#   1) 번들 Python 과 패키지 확인 (없는 패키지는 .runtime\wheels 에서 오프라인 설치)
#   2) Rust 네이티브 엔진(prism_core) · 화면(frontend\dist) · 게이트웨이 에이전트 확인
#   3) PostgreSQL: 번들 바이너리로 DB 클러스터·계정·DB 생성, 접속 정보는 backend\.env (처음 한 번)
#   4) DB 테이블 생성/보정, 기본 노드 라이브러리 (+ 데모)
#   5) settings\ 설정 폴더가 있으면 들여오기 (같은 이름은 건너뜀, 수집·자동 실행은 꺼진 채로)
#   6) Neo4j 가 번들에 있으면 초기 비밀번호 설정 (선택 기능)
# 인터넷 연결이 필요 없다 (폐쇄망용). 필요한 파일은 scripts\build-bundle.ps1 로 만든 배포 폴더에 모두 들어 있다.
param(
    [string]$Settings = '',
    [switch]$NoSettings,
    [switch]$NoDemo,
    [int]$PgPort = 5432
)
. "$PSScriptRoot\common.ps1"

Write-Host "PRISM install — $Root" -ForegroundColor White

# ---------- 1) Python ----------
Write-Step '1/6 Python'
$py = Get-Python
if (-not $py) { throw '.runtime\python 이 없습니다. 인터넷이 되는 PC 에서 scripts\build-bundle.ps1 로 만든 배포 폴더를 사용하세요.' }
$ver = & $py -c "import sys; print(sys.version.split()[0])"
Write-Ok "Python $ver  ($py)"
$probe = 'import fastapi, uvicorn, sqlalchemy, pydantic, pandas, numpy, psycopg, paramiko, neo4j'
& $py -c $probe 2>$null
if ($LASTEXITCODE -ne 0) {
    $wheels = Join-Path $Runtime 'wheels'
    if (-not (Test-Path $wheels)) { throw '필요한 Python 패키지가 없고 .runtime\wheels 도 없습니다. 배포 폴더를 다시 복사하세요.' }
    Write-Info '패키지 설치 (오프라인: .runtime\wheels) ...'
    & $py -m pip install --no-index --find-links $wheels --no-warn-script-location -q -r (Join-Path $Backend 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'pip install 실패' }
    & $py -c $probe
    if ($LASTEXITCODE -ne 0) { throw '패키지 확인 실패' }
}
Write-Ok 'Python packages'

# ---------- 2) 네이티브 엔진 · 화면 · 에이전트 ----------
Write-Step '2/6 Native engine / web UI'
Push-Location $Backend
try {
    $nv = & $py -c "from app import prism_core; print(prism_core.version())" 2>$null
} finally { Pop-Location }
if ($LASTEXITCODE -ne 0 -or -not $nv) {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        Write-Info 'prism_core 빌드 (Rust) ...'
        & (Join-Path $PSScriptRoot 'build-native.ps1')
    } else {
        throw 'Rust 엔진(backend\app\prism_core.pyd)이 없습니다. 배포 폴더를 다시 복사하세요.'
    }
} else { Write-Ok "prism_core $nv (Rust)" }
if (-not (Test-Path (Join-Path $Root 'frontend\dist\index.html'))) {
    if ((Get-Command npm -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $Root 'frontend\node_modules'))) {
        Push-Location (Join-Path $Root 'frontend'); try { npm run build } finally { Pop-Location }
    } else { throw '화면(frontend\dist)이 없습니다. 배포 폴더를 다시 복사하세요.' }
}
Write-Ok 'web UI (frontend\dist)'
if (Test-Path (Join-Path $Root 'agent\prism-agent.exe')) { Write-Ok 'gateway agent (agent\prism-agent.exe)' } else { Write-Warn2 'agent\prism-agent.exe 없음 (별도 LAN 설비를 쓸 때만 필요)' }

# ---------- 3) PostgreSQL ----------
Write-Step '3/6 PostgreSQL'
$envs = Read-EnvFile
if (Test-Path (Join-Path $PgBin 'postgres.exe')) {
    if (Test-Path (Join-Path $PgData 'PG_VERSION')) {
        Write-Ok "DB cluster exists (backend\data\postgres)"
        if (-not $envs['PRISM_DATABASE_URL']) { Write-Warn2 'backend\.env 에 PRISM_DATABASE_URL 이 없습니다. 이전 설치의 backend\.env 를 함께 복사했는지 확인하세요.' }
    } else {
        & (Join-Path $PSScriptRoot 'install-postgres.ps1') -Port $PgPort
        Write-Ok 'DB cluster created, connection saved to backend\.env'
    }
} elseif ($envs['PRISM_DATABASE_URL']) {
    Write-Ok 'external database (PRISM_DATABASE_URL in backend\.env)'
} else {
    Write-Warn2 '번들 PostgreSQL 이 없어 SQLite(backend\data\prism.db)를 사용합니다. 설비가 많으면 PostgreSQL 을 권장합니다.'
}

# ---------- 4) DB 테이블 ----------
Write-Step '4/6 Database'
$startedPg = $false
if (Test-PgCluster) { $wasRunning = Test-PgRunning; $null = Start-Pg; $startedPg = -not $wasRunning }
try {
    if ($NoDemo) { $env:PRISM_SEED_DEMO = '0' }
    Push-Location $Backend
    try { & $py -m app.setup } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'DB 준비 실패 (위 오류 참고)' }
    Write-Ok 'tables ready'

    # ---------- 5) 설정 폴더 ----------
    Write-Step '5/6 Settings folder'
    $src = if ($Settings) { $Settings } else { $SettingsDir }
    if ($NoSettings) {
        Write-Info '건너뜀 (-NoSettings)'
    } elseif (Test-Path (Join-Path $src 'prism-settings.json')) {
        Write-Info "들여오기: $src  (같은 이름은 건너뜀, 설비 수집·Flow 자동 실행은 꺼진 채로)"
        Push-Location $Backend
        try { & $py -m app.workspace import $src } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw '설정 들여오기 실패' }
        Write-Ok 'settings imported — 화면에서 설비 경로·계정을 확인한 뒤 수집을 켜세요'
    } else {
        Write-Info "settings\ 폴더가 없어 건너뜀 (다른 서버의 설정을 옮기려면 그 서버에서 Settings > Save to settings folder 후 이 폴더에 복사)"
    }
} finally {
    if ($startedPg) { $null = Stop-Pg }
}

# ---------- 6) Neo4j (선택) ----------
Write-Step '6/6 Neo4j (optional)'
if (Get-Neo4jHome) {
    if ((Read-EnvFile)['PRISM_NEO4J_PASSWORD']) { Write-Ok 'Neo4j configured' }
    else {
        & (Join-Path $PSScriptRoot 'install-neo4j.ps1')
        Write-Ok 'Neo4j password set (backend\.env)'
    }
} else { Write-Info '번들에 Neo4j 가 없어 건너뜀 (제품 계보 그래프 기능만 꺼짐)' }

New-Item -ItemType Directory -Force $RunDir, $LogDir | Out-Null
@{ installed_at = (Get-Date).ToString('s'); python = $ver; native = $nv } | ConvertTo-Json | Set-Content (Join-Path $Runtime 'installed.json') -Encoding UTF8
Write-Host ''
Write-Host '설치 완료. run.bat 으로 서버를 시작하고, stop.bat 으로 멈춥니다.' -ForegroundColor Green
