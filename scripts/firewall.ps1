# 다른 PC 에서 PRISM 화면·API 에 접속할 수 있게 Windows 방화벽을 연다 (firewall.bat, install.bat 의 마지막 단계)
#   - 서비스 포트(기본 8000, backend\.env 의 PRISM_PORT)로 들어오는 TCP 를 허용하는 규칙 "PRISM web (TCP 포트)" 을 만든다.
#     프로그램 경로가 아니라 포트 기준이라 PRISM 폴더를 옮겨도 그대로 동작한다.
#   - 처음 실행 때 뜬 방화벽 확인 창을 닫거나 거부하면 Windows 가 이 설치의 python.exe 에 '차단' 규칙을 만드는데,
#     차단 규칙은 허용 규칙보다 우선하므로 함께 지운다.
#   - 관리자 권한이 필요하다. 관리자가 아니면 UAC 확인 창으로 다시 실행한다.
# 옵션: -Port 9000 / -RemoteAddress LocalSubnet (같은 서브넷만, 기본 Any) / -Check (확인만) / -Remove (규칙 삭제)
param([int]$Port = 0, [string]$RemoteAddress = 'Any', [switch]$Check, [switch]$Remove)
. "$PSScriptRoot\common.ps1"

if (-not $Port) { $envs = Read-EnvFile; $Port = if ($envs['PRISM_PORT']) { [int]$envs['PRISM_PORT'] } else { 8000 } }
$group = 'PRISM'
$ruleName = "PRISM web (TCP $Port)"
$py = Get-Python

function Get-FirewallState {
    $allow = @(Get-NetFirewallRule -Group $group -Direction Inbound -ErrorAction SilentlyContinue |
        Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and (($_ | Get-NetFirewallPortFilter).LocalPort -contains "$Port") })
    $blocks = @()
    if ($py) {
        $full = (Resolve-Path $py).Path
        foreach ($p in @($full, $full.ToLower()) | Select-Object -Unique) {
            $blocks += @(Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
                Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' })
        }
    }
    return @{ Allow = $allow; Blocks = @($blocks | Sort-Object Name -Unique) }
}

function Show-State($s) {
    if ($s.Allow.Count) { Write-Ok "inbound TCP $Port allowed ($($s.Allow[0].DisplayName))" } else { Write-Warn2 "inbound TCP $Port 허용 규칙 없음" }
    if ($s.Blocks.Count) { Write-Warn2 "이 설치의 python.exe 를 막는 차단 규칙 $($s.Blocks.Count)개 (방화벽 확인 창을 거부/닫았을 때 생김)" }
}

$state = Get-FirewallState
if ($Check) {
    Show-State $state
    exit ([int](-not ($state.Allow.Count -and -not $state.Blocks.Count)))
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Info '방화벽을 바꾸려면 관리자 권한이 필요합니다. 확인 창(UAC)이 뜨면 "예"를 누르세요.'
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port -RemoteAddress $RemoteAddress" + $(if ($Remove) { ' -Remove' } else { '' })
    try {
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -PassThru -Wait
    } catch {
        Write-Warn2 '관리자 권한을 받지 못해 방화벽을 바꾸지 않았습니다. 관리자에게 이 PC 의 TCP 포트 허용을 요청하거나, 관리자 계정으로 firewall.bat 을 실행하세요.'
        exit 1
    }
    $state = Get-FirewallState
    Show-State $state
    exit ([int](-not ($Remove -or ($state.Allow.Count -and -not $state.Blocks.Count))))
}

# ---- 관리자 권한으로 실행 중 ----
Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) {
    Write-Ok 'PRISM 방화벽 규칙을 지웠습니다.'
    exit 0
}
New-NetFirewallRule -DisplayName $ruleName -Group $group -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -Profile Any -RemoteAddress $RemoteAddress -Description 'PRISM 화면·API (다른 PC 에서 접속). firewall.bat -Remove 로 지움' | Out-Null
foreach ($r in $state.Blocks) { $r | Remove-NetFirewallRule }
Show-State (Get-FirewallState)
if ($Host.Name -eq 'ConsoleHost' -and -not $env:PRISM_NO_PAUSE) { Start-Sleep -Seconds 2 }
