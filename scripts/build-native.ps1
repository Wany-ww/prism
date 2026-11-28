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
# 실행 중인 서버가 .pyd 를 쥐고 있으면 덮어쓸 수 없으므로 먼저 stop.bat 으로 멈춰야 함
Copy-Item (Join-Path $out 'prism_core.dll') (Join-Path $root 'backend\app\prism_core.pyd') -Force
Copy-Item (Join-Path $out 'prism-agent.exe') (Join-Path $root 'agent\prism-agent.exe') -Force
Write-Host "built: backend\app\prism_core.pyd, agent\prism-agent.exe ($profile)"
