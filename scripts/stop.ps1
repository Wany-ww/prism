# PRISM 중지 (stop.bat) — PRISM 서버(작업 프로세스·AI 에이전트 포함) → Neo4j → PostgreSQL 순서로 멈춘다.
. "$PSScriptRoot\common.ps1"

Write-Step 'PRISM server'
$p = Get-PidProcess 'backend'
if ($p) {
    Stop-Tree $p.Id
    Remove-Item (Join-Path $RunDir 'backend.pid') -ErrorAction SilentlyContinue
    Write-Ok "stopped (PID $($p.Id))"
} else {
    # PID 파일 없이 떠 있는 서버(예: 직접 실행)도 이 설치의 Python 이면 멈춤
    $py = Get-Python
    $port = 8000
    $envs = Read-EnvFile
    if ($envs['PRISM_PORT']) { $port = [int]$envs['PRISM_PORT'] }
    $owner = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
    $proc = if ($owner) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
    if ($proc -and $py -and $proc.Path -and ((Resolve-Path $proc.Path).Path -eq (Resolve-Path $py).Path)) {
        Stop-Tree $proc.Id
        Write-Ok "stopped (PID $($proc.Id), port $port)"
    } else { Write-Info 'not running' }
}

Write-Step 'Neo4j'
$n = Get-PidProcess 'neo4j'
if ($n) {
    Stop-Tree $n.Id
    Remove-Item (Join-Path $RunDir 'neo4j.pid') -ErrorAction SilentlyContinue
    Write-Ok 'stopped'
} else { Write-Info 'not running' }

Write-Step 'PostgreSQL'
if (Stop-Pg) { Write-Ok 'stopped' } else { Write-Info 'not running' }
Write-Host ''
Write-Host 'PRISM 을 멈췄습니다.' -ForegroundColor Green
