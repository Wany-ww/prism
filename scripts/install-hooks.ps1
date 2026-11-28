# git 훅 설치: .githooks\pre-push → .git\hooks\pre-push (git 설정은 바꾸지 않음)
#   main 을 푸시하면 scripts\release.ps1 이 배포 버전(dist\PRISM + zip)을 백그라운드로 만든다.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$hooks = Join-Path $root '.git\hooks'
if (-not (Test-Path $hooks)) { throw '.git\hooks 가 없습니다 (git 저장소에서 실행하세요).' }
Copy-Item (Join-Path $root '.githooks\pre-push') (Join-Path $hooks 'pre-push') -Force
Write-Host 'installed: .git\hooks\pre-push (main 푸시 → 배포 버전 자동 빌드, logs\release.log)'