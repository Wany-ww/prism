# 폐쇄망 배포 폴더 만들기 (인터넷이 되는 PC 에서) → dist\PRISM\ (와 -Zip 이면 dist\PRISM-날짜.zip)
#   이 폴더를 서버에 복사하고 install.bat → run.bat. 서버에는 Python·PostgreSQL·Node·Rust 설치가 필요 없다.
#   들어가는 것: 앱 코드, 번들 Python(+패키지, wheel 원본), PostgreSQL 바이너리, Rust 엔진/에이전트, 화면 빌드,
#              (있으면) Neo4j + JDK, install/run/stop.bat
#   들어가지 않는 것: backend\data (DB·수집 데이터), backend\.env (비밀번호), 개발 도구(.venv, node_modules, native\target)
# 옵션:
#   -WithSettings   이 PC 의 현재 설정을 settings\ 로 내보내 함께 넣음 (새 서버 install 때 자동으로 들여옴)
#   -NoNeo4j        Neo4j/JDK 를 넣지 않음 (약 350MB 절약, 제품 계보 그래프 기능만 꺼짐)
#   -Zip            zip 파일도 만듦
#   -SkipPrepare    prepare-runtime.ps1 을 건너뜀 (이미 준비된 .runtime 사용)
param([string]$Out = '', [switch]$WithSettings, [switch]$NoNeo4j, [switch]$Zip, [switch]$SkipPrepare)
. "$PSScriptRoot\common.ps1"

if (-not $SkipPrepare) { & (Join-Path $PSScriptRoot 'prepare-runtime.ps1') }

# 배포에 꼭 필요한 빌드 결과물 (-SkipPrepare 면 prepare-runtime 을 건너뛰므로 여기서 확인)
$required = @{
    '.runtime\python\python.exe' = 'Python 런타임'
    '.runtime\wheels' = '패키지 원본(wheel)'
    'backend\app\prism_core.pyd' = 'Rust 엔진'
    'agent\prism-agent.exe' = '게이트웨이 에이전트'
    'frontend\dist\index.html' = '화면 빌드'
}
$missing = $required.Keys | Where-Object { -not (Test-Path (Join-Path $Root $_)) }
if ($missing) {
    throw ("배포에 필요한 파일이 없습니다: " + (($missing | ForEach-Object { "$_ ($($required[$_]))" }) -join ', ') + '. -SkipPrepare 없이 실행하세요.')
}
& (Join-Path $Runtime 'python\python.exe') -c 'import fastapi, uvicorn, sqlalchemy, pandas, numpy, psycopg, paramiko, neo4j' 2>$null
if ($LASTEXITCODE -ne 0) { throw '.runtime\python 에 패키지가 다 설치되어 있지 않습니다. -SkipPrepare 없이 실행하세요.' }
# 소스가 빌드보다 새로우면 예전 결과물이 들어가므로 알림
function Test-Newer([string]$built, [string[]]$sources) {
    $t = (Get-Item (Join-Path $Root $built)).LastWriteTime
    foreach ($s in $sources) {
        $p = Join-Path $Root $s
        if ((Test-Path $p) -and (Get-ChildItem $p -Recurse -File | Where-Object { $_.FullName -notmatch '\\target\\' -and $_.LastWriteTime -gt $t } | Select-Object -First 1)) { return $true }
    }
    return $false
}
$stale = @()
if (Test-Newer 'backend\app\prism_core.pyd' @('native\prism_core', 'native\Cargo.toml')) { $stale += 'Rust 엔진 (native\prism_core)' }
if (Test-Newer 'agent\prism-agent.exe' @('native\prism_agent')) { $stale += '게이트웨이 에이전트 (native\prism_agent)' }
if (Test-Newer 'frontend\dist\index.html' @('frontend\src')) { $stale += '화면 (frontend\src)' }
if ($stale) {
    if ($SkipPrepare) { throw ("소스가 빌드 결과보다 새롭습니다: " + ($stale -join ', ') + '. -SkipPrepare 없이 실행하거나 먼저 다시 빌드하세요.') }
    else { Write-Warn2 ("소스가 빌드 결과보다 새롭습니다: " + ($stale -join ', ')) }
}
if (-not $Out) { $Out = Join-Path $Root 'dist\PRISM' }
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force $Out | Out-Null

function Copy-Tree([string]$from, [string]$to, [string[]]$excludeDirs = @(), [string[]]$excludeFiles = @()) {
    $args2 = @($from, $to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', '__pycache__') + $excludeDirs
    if ($excludeFiles.Count) { $args2 += @('/XF') + $excludeFiles }
    & robocopy.exe @args2 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copy failed: $from" }
}

Write-Step 'App'
foreach ($f in 'install.bat', 'run.bat', 'stop.bat', 'README.md') { Copy-Item (Join-Path $Root $f) $Out }
Copy-Tree (Join-Path $Backend 'app') (Join-Path $Out 'backend\app')
Copy-Item (Join-Path $Backend 'requirements.txt') (Join-Path $Out 'backend')
Copy-Tree (Join-Path $Root 'scripts') (Join-Path $Out 'scripts')
Copy-Tree (Join-Path $Root 'frontend\dist') (Join-Path $Out 'frontend\dist')
New-Item -ItemType Directory -Force (Join-Path $Out 'agent') | Out-Null
Copy-Item (Join-Path $Root 'agent\prism-agent.exe') (Join-Path $Out 'agent')
if (Test-Path (Join-Path $Root 'demo')) { Copy-Tree (Join-Path $Root 'demo') (Join-Path $Out 'demo') }
if (Test-Path (Join-Path $Root '.claude\skills')) { Copy-Tree (Join-Path $Root '.claude\skills') (Join-Path $Out '.claude\skills') }
Write-Ok 'backend, frontend\dist, agent, scripts'

Write-Step 'Runtime'
Copy-Tree (Join-Path $Runtime 'python') (Join-Path $Out '.runtime\python')
Copy-Tree (Join-Path $Runtime 'wheels') (Join-Path $Out '.runtime\wheels')
if (Test-Path $PgBin) {
    # 서버 실행에 필요한 것만 (pgAdmin, StackBuilder, 문서, 헤더 제외)
    # StackBuilder(설치 마법사, wx*.dll)는 서버 실행에 필요 없음
    foreach ($d in 'bin', 'lib', 'share') { Copy-Tree (Join-Path $PgHome $d) (Join-Path $Out ".runtime\pgsql\$d") @('pgAdmin 4') @('*.pdb', 'stackbuilder.exe', 'wx*.dll') }
    # PostgreSQL 바이너리는 Visual C++ 런타임(VCRUNTIME140 · VCRUNTIME140_1 · MSVCP140)이 필요한데 zip 에 없음 →
    # 이 PC 의 64비트 런타임을 bin 에 함께 넣어(앱 로컬 배포) 서버에 VC++ 재배포 패키지를 설치하지 않아도 되게 함
    $sys32 = Join-Path $env:SystemRoot 'System32'
    foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') {
        $src = Join-Path $sys32 $dll
        if (-not [Environment]::Is64BitProcess) { $src = Join-Path $env:SystemRoot "Sysnative\$dll" }
        if (Test-Path $src) { Copy-Item $src (Join-Path $Out ".runtime\pgsql\bin\$dll") -Force }
        else { throw "$dll 이 이 PC 에 없습니다. Visual C++ 2015-2022 재배포 패키지(x64)를 설치한 뒤 다시 실행하세요." }
    }
    Write-Ok 'PostgreSQL (+ Visual C++ runtime)'
} else { Write-Warn2 'PostgreSQL 바이너리가 없어 넣지 않았습니다 (install 시 SQLite 사용)' }
if (-not $NoNeo4j -and (Get-Neo4jHome)) {
    Copy-Tree (Join-Path $Runtime 'jdk') (Join-Path $Out '.runtime\jdk')
    Copy-Tree (Join-Path $Runtime 'neo4j') (Join-Path $Out '.runtime\neo4j') @('data', 'logs')
    Write-Ok 'Neo4j + JDK'
}

if ($WithSettings) {
    Write-Step 'Settings'
    $wasRunning = (Test-PgCluster) -and (Test-PgRunning)
    if (Test-PgCluster) { $null = Start-Pg }
    try {
        Push-Location $Backend
        try { & (Join-Path $Runtime 'python\python.exe') -m app.workspace export (Join-Path $Out 'settings') } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'settings export failed' }
    } finally { if ((Test-PgCluster) -and -not $wasRunning) { $null = Stop-Pg } }
    Write-Ok 'settings\ (새 서버 install 때 자동으로 들여옴)'
}

$size = (Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ''
Write-Host ("배포 폴더: {0}  ({1:N0} MB)" -f $Out, $size) -ForegroundColor Green
if ($Zip) {
    $zipPath = Join-Path (Split-Path $Out -Parent) ("PRISM-{0:yyyyMMdd}.zip" -f (Get-Date))
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    & tar.exe -a -c -f $zipPath -C (Split-Path $Out -Parent) (Split-Path $Out -Leaf)
    if ($LASTEXITCODE -ne 0) { throw 'zip failed' }
    Write-Host ("zip: {0}  ({1:N0} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB)) -ForegroundColor Green
}
Write-Host '서버에서: 폴더를 복사 → install.bat → run.bat'
