# Rust 네이티브 엔진(prism_core)과 게이트웨이 에이전트(prism-agent.exe) 빌드
#   결과: backend\app\prism_core.pyd, agent\prism-agent.exe
#   필요: Rust (cargo). 인터넷이 안 되면 먼저 인터넷 PC 에서 `cargo vendor` 로 받아 둔 native\vendor 가 있어야 함.
#   빌드한 결과물은 배포 묶음(scripts\build-bundle.ps1)에 들어가므로 폐쇄망 서버에는 Rust 가 필요 없다.
param([switch]$Debug)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$native = Join-Path $root 'native'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo 가 없습니다. Rust 를 설치하세요 (https://rustup.rs).' }

# pyo3 가 확장 모듈 링크 정보를 얻을 Python (번들 Python 이 있으면 그것)
$py = Join-Path $root '.runtime\python\python.exe'
if (-not (Test-Path $py)) { $py = Join-Path $root 'backend\.venv\Scripts\python.exe' }
if (Test-Path $py) { $env:PYO3_PYTHON = $py }

$profile = if ($Debug) { 'debug' } else { 'release' }
$cargoArgs = @('build', '--manifest-path', (Join-Path $native 'Cargo.toml'))
if (-not $Debug) { $cargoArgs += '--release' }
if (Test-Path (Join-Path $native 'vendor')) { $cargoArgs += '--offline' }
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }

$out = Join-Path $native "target\$profile"
# 실행 중인 서버가 .pyd 를 쥐고 있으면 덮어쓸 수 없음 → 경고만 (배포 빌드는 native\target 결과를 직접 씀)
foreach ($pair in @(@('prism_core.dll', 'backend\app\prism_core.pyd'), @('prism-agent.exe', 'agent\prism-agent.exe'))) {
    try {
        Copy-Item (Join-Path $out $pair[0]) (Join-Path $root $pair[1]) -Force -ErrorAction Stop
        Write-Host "built: $($pair[1]) ($profile)"
    } catch {
        Write-Warning "$($pair[1]) 를 바꾸지 못했습니다 (실행 중인 서버가 사용 중). stop.bat 후 다시 빌드하면 바뀝니다. 빌드 결과는 native\target\$profile 에 있습니다."
    }
}
