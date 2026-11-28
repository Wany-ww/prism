# PRISM 실행 (run.bat) — PostgreSQL → Neo4j(있으면) → PRISM 서버(화면·API·수집·Flow 스케줄러)를 백그라운드로 띄운다.
#   -Port 8000      서비스 포트
#   -Foreground     서버를 이 창에서 실행 (Ctrl+C 로 종료, 개발용)
#   -Open           시작 후 브라우저로 화면 열기
# 로그: logs\backend.log, logs\postgres.log, logs\neo4j.log  /  멈추기: stop.bat
param([int]$Port = 0, [switch]$Foreground, [switch]$Open)
. "$PSScriptRoot\common.ps1"

if (-not (Test-Path (Join-Path $Runtime 'installed.json')) -and -not (Test-Path (Join-Path $Backend '.venv'))) {
    throw '아직 설치하지 않았습니다. 먼저 install.bat 을 실행하세요.'
}
$envs = Read-EnvFile
if (-not $Port) { $Port = if ($envs['PRISM_PORT']) { [int]$envs['PRISM_PORT'] } else { 8000 } }
$py = Get-Python
if (-not $py) { throw 'Python 이 없습니다. install.bat 을 먼저 실행하세요.' }
New-Item -ItemType Directory -Force $LogDir, $RunDir | Out-Null

$running = Get-PidProcess 'backend'
if ($running -and -not $Foreground) {
    Write-Host "PRISM 이 이미 실행 중입니다 (PID $($running.Id))." -ForegroundColor Yellow
    Get-LanUrls $Port | ForEach-Object { Write-Host "  $_" }
    exit 0
}

# 1) PostgreSQL
if (Test-PgCluster) {
    Write-Step 'PostgreSQL'
    $null = Start-Pg
    Write-Ok 'running (localhost only)'
}

# 2) Neo4j (설치되어 있고 backend\.env 에 설정이 있을 때만)
$neo = Get-Neo4jHome
if ($neo -and $envs['PRISM_NEO4J_URI'] -and -not (Get-PidProcess 'neo4j')) {
    Write-Step 'Neo4j'
    $env:JAVA_HOME = $neo.Jdk
    $env:Path = (Join-Path $neo.Jdk 'bin') + ';' + $env:Path
    $p = Start-Detached (Join-Path $neo.Neo 'bin\neo4j.bat') 'console' (Join-Path $LogDir 'neo4j.log') $neo.Neo
    Save-Pid 'neo4j' $p.Id
    Write-Ok "starting (PID $($p.Id)) — bolt://127.0.0.1:7687"
}

# 3) PRISM 서버
Write-Step "PRISM server (port $Port)"
$env:PRISM_AI_API_URL = if ($envs['PRISM_AI_API_URL']) { $envs['PRISM_AI_API_URL'] } else { "http://127.0.0.1:$Port" }
$uv = @('-m', 'uvicorn', 'app.main:app', '--app-dir', "`"$Backend`"", '--host', '0.0.0.0', '--port', "$Port")
if ($Foreground) {
    Push-Location $Backend
    try { & $py @($uv | ForEach-Object { $_.Trim('"') }) } finally { Pop-Location }
    exit $LASTEXITCODE
}
$log = Join-Path $LogDir 'backend.log'
$err = Join-Path $LogDir 'backend.err.log'
$p = Start-Detached $py ($uv -join ' ') $log $Backend
Save-Pid 'backend' $p.Id
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if ($p.HasExited) { break }
    if (Test-Http "http://127.0.0.1:$Port/api/health") { $ok = $true; break }
}
if (-not $ok) {
    Write-Host '서버가 시작되지 않았습니다. logs\backend.err.log 마지막 부분:' -ForegroundColor Red
    Get-Content $err -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    if (-not $p.HasExited) { Stop-Tree $p.Id }
    Remove-Item (Join-Path $RunDir 'backend.pid') -ErrorAction SilentlyContinue
    exit 1
}
Write-Ok "running (PID $($p.Id))"
Write-Host ''
Write-Host 'PRISM 이 실행 중입니다. 브라우저에서 접속하세요:' -ForegroundColor Green
Get-LanUrls $Port | ForEach-Object { Write-Host "  $_" }
# 다른 PC 에서 접속되는지 (방화벽 규칙) 확인만
$null = & (Join-Path $PSScriptRoot 'firewall.ps1') -Port $Port -Check *>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 "PRISM 방화벽 규칙(TCP $Port)이 없어 다른 PC 에서는 접속되지 않을 수 있습니다 → firewall.bat 실행 (관리자 권한)"
}
Write-Host '멈추려면 stop.bat'
if ($Open) { Start-Process "http://localhost:$Port" }
