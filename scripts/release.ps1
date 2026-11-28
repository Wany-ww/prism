# 배포 버전 자동 빌드 (git push 후 .git\hooks\pre-push 가 백그라운드로 실행) → dist\PRISM\ + dist\PRISM-날짜-커밋.zip
#   1) 푸시가 끝날 때까지 기다림 (원격 추적 브랜치가 이 커밋이 되면 진행, 푸시가 실패하면 빌드하지 않음)
#   2) 소스가 빌드보다 새로운 부분만 인터넷 없이 다시 빌드 (화면: npm run build, Rust: cargo)
#   3) build-bundle.ps1 -SkipPrepare -Zip
#   로그: logs\release.log (마지막 실행), logs\release-history.log (한 줄씩 누적)
#   직접 실행도 가능: .\scripts\release.ps1
param([string]$Sha = '', [string]$Branch = 'main', [int]$WaitSec = 180, [int]$KeepZips = 5)
. "$PSScriptRoot\common.ps1"
New-Item -ItemType Directory -Force $LogDir, $RunDir | Out-Null

# 같은 시간에 두 번 돌지 않게
$lock = Join-Path $RunDir 'release.pid'
$prev = Get-PidProcess 'release'
if ($prev) { Add-Content (Join-Path $LogDir 'release-history.log') "$(Get-Date -Format s)  skipped: release build already running (PID $($prev.Id))"; exit 0 }
Save-Pid 'release' $PID

$log = Join-Path $LogDir 'release.log'
Start-Transcript -Path $log -Force | Out-Null
$status = 'failed'
$tag = ''
try {
    Push-Location $Root
    if (-not $Sha) { $Sha = (git rev-parse HEAD).Trim() }
    $short = $Sha.Substring(0, 7)
    Write-Host "release build for $short ($Branch)"

    # 1) 푸시 완료 대기
    if ($WaitSec -gt 0) {
        $deadline = (Get-Date).AddSeconds($WaitSec)
        while ($true) {
            $remote = (git rev-parse --verify --quiet "refs/remotes/origin/$Branch" 2>$null)
            if ($remote -and $remote.Trim() -eq $Sha) { break }
            if ((Get-Date) -gt $deadline) { throw "push of $short did not complete within $WaitSec s — no release built" }
            Start-Sleep -Seconds 2
        }
        Write-Ok "pushed: origin/$Branch = $short"
    }
    $dirty = [bool](git status --porcelain --untracked-files=no)
    $tag = $short + $(if ($dirty) { '-dirty' } else { '' })
    if ($dirty) { Write-Warn2 '커밋하지 않은 변경이 있어 작업 폴더 그대로 빌드합니다 (zip 이름에 -dirty).' }

    # 2) 오래된 빌드만 다시 (인터넷 없이)
    $dist = Join-Path $Root 'frontend\dist\index.html'
    $frontStale = -not (Test-Path $dist) -or (Get-ChildItem (Join-Path $Root 'frontend\src') -Recurse -File | Where-Object { $_.LastWriteTime -gt (Get-Item $dist).LastWriteTime } | Select-Object -First 1)
    if ($frontStale) {
        if ((Get-Command npm -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $Root 'frontend\node_modules'))) {
            Write-Step 'Web UI build'
            Push-Location (Join-Path $Root 'frontend')
            try { npm run build; if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' } } finally { Pop-Location }
        } else { throw '화면 소스가 빌드보다 새로운데 npm/node_modules 가 없습니다.' }
    }
    # 결과물마다 자기 소스와 비교 (설치본과 native\target 중 더 새로운 것 기준)
    function Test-RustStale([string[]]$outputs, [string[]]$sources) {
        $t = $outputs | Where-Object { Test-Path $_ } | ForEach-Object { (Get-Item $_).LastWriteTime } | Sort-Object -Descending | Select-Object -First 1
        if (-not $t) { return $true }
        return [bool]($sources | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -File } | Where-Object { $_.LastWriteTime -gt $t } | Select-Object -First 1)
    }
    $n = Join-Path $Root 'native'
    $coreStale = Test-RustStale @((Join-Path $Backend 'app\prism_core.pyd'), "$n\target\release\prism_core.dll") @("$n\prism_core", "$n\Cargo.toml")
    $agentStale = Test-RustStale @((Join-Path $Root 'agent\prism-agent.exe'), "$n\target\release\prism-agent.exe") @("$n\prism_agent")
    if ($coreStale -or $agentStale) {
        if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust 소스가 빌드보다 새로운데 cargo 가 없습니다.' }
        Write-Step 'Native build (Rust)'
        & (Join-Path $PSScriptRoot 'build-native.ps1')
    }

    # 3) 배포 폴더 + zip
    & (Join-Path $PSScriptRoot 'build-bundle.ps1') -SkipPrepare -Zip -Tag $tag
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "build-bundle failed ($LASTEXITCODE)" }

    # 오래된 zip 정리 (최근 $KeepZips 개만)
    Get-ChildItem (Join-Path $Root 'dist') -Filter 'PRISM-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $KeepZips | Remove-Item -Force
    $status = 'ok'
} catch {
    Write-Host "release build failed: $_" -ForegroundColor Red
} finally {
    Pop-Location -ErrorAction SilentlyContinue
    Stop-Transcript | Out-Null
    Remove-Item $lock -ErrorAction SilentlyContinue
    $zip = Get-ChildItem (Join-Path $Root 'dist') -Filter "PRISM-*$tag.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    Add-Content (Join-Path $LogDir 'release-history.log') ("{0}  {1}  {2}  {3}" -f (Get-Date -Format s), $status, $tag, $(if ($status -eq 'ok' -and $zip) { $zip.Name } else { 'see logs\release.log' }))
}
