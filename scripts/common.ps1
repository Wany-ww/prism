# install / run / stop 공통 경로와 함수 (다른 스크립트에서 . "$PSScriptRoot\common.ps1" 로 불러 씀)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path $PSScriptRoot -Parent
$Runtime = Join-Path $Root '.runtime'
$Backend = Join-Path $Root 'backend'
$EnvFile = Join-Path $Backend '.env'
$LogDir = Join-Path $Root 'logs'
$RunDir = Join-Path $Runtime 'run'
$PgHome = Join-Path $Runtime 'pgsql'
$PgBin = Join-Path $PgHome 'bin'
$PgData = Join-Path $Backend 'data\postgres'
$SettingsDir = Join-Path $Root 'settings'
# Python 이 한글 경로·출력을 UTF-8 로 다루도록
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

function Write-Step([string]$msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "       $msg" }
function Write-Warn2([string]$msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }

# 번들 Python (.runtime\python) → 없으면 개발용 가상환경
function Get-Python {
    foreach ($p in @((Join-Path $Runtime 'python\python.exe'), (Join-Path $Backend '.venv\Scripts\python.exe'))) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Read-EnvFile {
    $h = @{}
    if (Test-Path $EnvFile) {
        foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $h[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
        }
    }
    return $h
}

function Set-EnvLine([string]$key, [string]$value) {
    $lines = @()
    if (Test-Path $EnvFile) { $lines = @(Get-Content $EnvFile -Encoding UTF8 | Where-Object { $_ -notmatch "^\s*$key\s*=" }) }
    $lines += "$key=$value"
    [System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

# pg_ctl 이 띄운 서버가 이 창의 표준 출력 핸들을 물려받아 쥐고 있으면 run.bat 을 부른 쪽이 끝나지 않으므로,
# 핸들을 물려주지 않는 방식(ShellExecute)으로 cmd 를 띄워 출력은 파일로 받고 pg_ctl 이 끝나기만 기다림
function Invoke-PgCtl([string]$arguments, [switch]$Quiet) {
    $out = Join-Path $env:TEMP "prism-pgctl-$([guid]::NewGuid().ToString('N'))"
    $cmdline = "/d /c `"`"$(Join-Path $PgBin 'pg_ctl.exe')`" $arguments > `"$out.out`" 2> `"$out.err`"`""
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdline -WindowStyle Hidden -PassThru
    $null = $p.Handle  # ExitCode 를 읽으려면 필요
    $p.WaitForExit()
    if (-not $Quiet) { Get-Content "$out.out", "$out.err" -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ } }
    Remove-Item "$out.out", "$out.err" -ErrorAction SilentlyContinue
    return $p.ExitCode
}

function Test-PgCluster { return (Test-Path (Join-Path $PgBin 'pg_ctl.exe')) -and (Test-Path (Join-Path $PgData 'PG_VERSION')) }
function Test-PgRunning { return (Invoke-PgCtl "-D `"$PgData`" status" -Quiet) -eq 0 }

function Start-Pg {
    if (-not (Test-PgCluster)) { return $false }
    if (Test-PgRunning) { return $true }
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    $code = Invoke-PgCtl "-D `"$PgData`" -l `"$(Join-Path $LogDir 'postgres.log')`" -w -t 60 start" -Quiet
    if ($code -ne 0) { throw "PostgreSQL did not start — see logs\postgres.log" }
    return $true
}

function Stop-Pg {
    if ((Test-PgCluster) -and (Test-PgRunning)) { $null = Invoke-PgCtl "-D `"$PgData`" -m fast -w stop" -Quiet; return $true }
    return $false
}

# PID 파일에 적힌 프로세스가 아직 살아 있으면 Process 객체
function Get-PidProcess([string]$name) {
    $f = Join-Path $RunDir "$name.pid"
    if (-not (Test-Path $f)) { return $null }
    $id = [int](Get-Content $f -TotalCount 1)
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { Remove-Item $f -ErrorAction SilentlyContinue }
    return $p
}

function Save-Pid([string]$name, [int]$id) {
    New-Item -ItemType Directory -Force $RunDir | Out-Null
    Set-Content (Join-Path $RunDir "$name.pid") $id -Encoding ASCII
}

# 창 없이 백그라운드 실행 + 출력은 파일로. 핸들을 물려주지 않도록(ShellExecute) cmd 가 리다이렉트를 맡는다.
# (Start-Process -Redirect* 는 이 창의 출력 핸들까지 물려줘서, 서버가 떠 있는 동안 run.bat 을 부른 쪽이 끝나지 않음)
function Start-Detached([string]$exe, [string]$arguments, [string]$log, [string]$workDir) {
    $err = [IO.Path]::ChangeExtension($log, '.err.log')
    foreach ($f in $log, $err) { if (Test-Path $f) { Move-Item $f "$f.1" -Force -ErrorAction SilentlyContinue } }  # 직전 로그 하나는 남김
    $cmdline = "/d /c `"`"$exe`" $arguments > `"$log`" 2> `"$err`"`""
    return Start-Process -FilePath $env:ComSpec -ArgumentList $cmdline -WorkingDirectory $workDir -WindowStyle Hidden -PassThru
}

function Stop-Tree([int]$id) {
    # 자식 프로세스(수집·Flow 작업 프로세스, AI 에이전트 등)까지 함께 종료
    & taskkill.exe /PID $id /T /F 2>&1 | Out-Null
}

function Get-Neo4jHome {
    $jdk = Get-ChildItem (Join-Path $Runtime 'jdk') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    $neo = Get-ChildItem (Join-Path $Runtime 'neo4j') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jdk -and $neo) { return @{ Jdk = $jdk.FullName; Neo = $neo.FullName } }
    return $null
}

function Test-Http([string]$url) {
    try { $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3; return $r.StatusCode -eq 200 } catch { return $false }
}

function Get-LanUrls([int]$port) {
    $ips = @()
    try {
        $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -ExpandProperty IPAddress
    } catch {}
    return @("http://localhost:$port") + ($ips | ForEach-Object { "http://${_}:$port" })
}
