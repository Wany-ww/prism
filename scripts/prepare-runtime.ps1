# 번들 런타임 준비 (인터넷이 되는 PC 에서 한 번) — 폐쇄망 서버에서 설치 없이 쓰도록 .runtime\ 에 모은다.
#   .runtime\python   이식 가능한 Python 3.11 + PRISM 패키지 (python-build-standalone 계열: 폴더째 복사해도 동작)
#   .runtime\wheels   패키지 원본(wheel) — 폐쇄망에서 패키지를 다시 설치할 때 (install.bat 이 자동 사용)
#   .runtime\pgsql    PostgreSQL 바이너리 (.runtime\downloads\pg\*.zip 이 있으면 풀어 둠)
#   backend\app\prism_core.pyd, agent\prism-agent.exe   Rust 엔진/에이전트 (cargo 가 있으면 빌드)
#   frontend\dist      화면 (npm 이 있으면 빌드)
# 옵션: -PythonHome <폴더>  복사해 올 이식형 Python (기본: backend\.venv 의 기반 Python)
param([string]$PythonHome = '', [switch]$Force)
. "$PSScriptRoot\common.ps1"

# ---------- Python ----------
Write-Step 'Python runtime'
$target = Join-Path $Runtime 'python'
if ($Force -and (Test-Path $target)) { Remove-Item $target -Recurse -Force }
if (-not (Test-Path (Join-Path $target 'python.exe'))) {
    if (-not $PythonHome) {
        $cfg = Join-Path $Backend '.venv\pyvenv.cfg'
        if (Test-Path $cfg) {
            $baseHome = (Get-Content $cfg | Where-Object { $_ -match '^home\s*=' }) -replace '^home\s*=\s*', ''
            if ($baseHome) { $PythonHome = $baseHome.Trim() }
        }
    }
    if (-not $PythonHome -or -not (Test-Path (Join-Path $PythonHome 'python.exe'))) {
        throw @'
복사해 올 Python 이 없습니다. 이식 가능한 Python 3.11 (python-build-standalone 의 *-x86_64-pc-windows-msvc-install_only 묶음,
또는 uv 가 설치한 Python) 폴더를 -PythonHome 으로 지정하세요.
  예) .\scripts\prepare-runtime.ps1 -PythonHome C:\tools\python311
'@
    }
    Write-Info "copy $PythonHome -> .runtime\python"
    New-Item -ItemType Directory -Force $target | Out-Null
    & robocopy.exe $PythonHome $target /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Python copy failed' }
    # uv/배포판이 붙여 둔 "외부 관리" 표시를 지워 pip 로 패키지를 넣을 수 있게
    Get-ChildItem (Join-Path $target 'Lib') -Filter 'EXTERNALLY-MANAGED' -ErrorAction SilentlyContinue | Remove-Item -Force
}
$py = Join-Path $target 'python.exe'
Write-Ok (& $py -c "import sys; print('Python', sys.version.split()[0])")

# ---------- 패키지 ----------
Write-Step 'Python packages (.runtime\wheels)'
$wheels = Join-Path $Runtime 'wheels'
New-Item -ItemType Directory -Force $wheels | Out-Null
$req = Join-Path $Backend 'requirements.txt'
& $py -m pip download --only-binary=:all: -d $wheels -r $req -q --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'pip download failed (인터넷 연결 확인)' }
& $py -m pip install --no-index --find-links $wheels -r $req -q --no-warn-script-location --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
Write-Ok "$((Get-ChildItem $wheels -Filter *.whl).Count) wheels"

# ---------- PostgreSQL 바이너리 ----------
Write-Step 'PostgreSQL binaries'
if (Test-Path (Join-Path $PgBin 'postgres.exe')) { Write-Ok (& (Join-Path $PgBin 'postgres.exe') --version) }
else {
    $zip = Get-ChildItem (Join-Path $Runtime 'downloads\pg') -Filter 'postgresql-*-windows-x64-binaries.zip' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $zip) {
        Write-Warn2 'PostgreSQL zip 이 없습니다: https://www.enterprisedb.com/download-postgresql-binaries 에서 Windows x64 binaries 를 받아 .runtime\downloads\pg\ 에 두고 다시 실행하세요.'
    } else {
        $tmp = Join-Path $Runtime 'pgsql-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        New-Item -ItemType Directory $tmp | Out-Null
        & $Tar -xf $zip.FullName -C $tmp
        if ($LASTEXITCODE -ne 0) { throw 'Extraction failed' }
        Move-Item (Join-Path $tmp 'pgsql') $PgHome
        Remove-Item $tmp -Recurse -Force
        Write-Ok (& (Join-Path $PgBin 'postgres.exe') --version)
    }
}

# ---------- Rust 엔진 / 에이전트 ----------
Write-Step 'Native engine (Rust)'
$pyd = Join-Path $Backend 'app\prism_core.pyd'
$src = Get-ChildItem (Join-Path $Root 'native') -Recurse -File -Include *.rs, Cargo.toml -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\target\\' }
$stale = -not (Test-Path $pyd) -or ($src | Where-Object { $_.LastWriteTime -gt (Get-Item $pyd).LastWriteTime } | Select-Object -First 1)
if ($stale) {
    if (Get-Command cargo -ErrorAction SilentlyContinue) { & (Join-Path $PSScriptRoot 'build-native.ps1') }
    elseif (-not (Test-Path $pyd)) { throw 'prism_core.pyd 가 없고 cargo 도 없습니다 (https://rustup.rs).' }
    else { Write-Warn2 'Rust 소스가 더 새롭지만 cargo 가 없어 기존 빌드를 사용합니다.' }
}
Push-Location $Backend
try { Write-Ok ("prism_core " + (& $py -c "from app import prism_core; print(prism_core.version())")) } finally { Pop-Location }

# ---------- 화면 ----------
Write-Step 'Web UI'
$dist = Join-Path $Root 'frontend\dist\index.html'
$fsrc = Join-Path $Root 'frontend\src'
$fstale = -not (Test-Path $dist) -or (Get-ChildItem $fsrc -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Item $dist).LastWriteTime } | Select-Object -First 1)
if ($fstale) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { if (-not (Test-Path $dist)) { throw 'frontend\dist 가 없고 npm 도 없습니다.' } }
    else {
        Push-Location (Join-Path $Root 'frontend')
        try {
            if (-not (Test-Path 'node_modules')) { npm ci }
            npm run build
            if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
        } finally { Pop-Location }
    }
}
Write-Ok 'frontend\dist'
Write-Host ''
Write-Host '런타임 준비 완료. 배포 폴더 만들기: .\scripts\build-bundle.ps1' -ForegroundColor Green
