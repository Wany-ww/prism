# 로컬 Neo4j 설치 (선택 기능: 제품 계보 그래프 / 영향 범위 분석)
#   .\scripts\install-neo4j.ps1
# 공식 배포처에서 OpenJDK 21(Adoptium)과 Neo4j Community 5.26 을 받아 SHA-256 을 검증한 뒤 .runtime\ 에 풉니다 (약 350MB).
# 비밀번호를 무작위로 만들어 Neo4j 에 설정하고 backend\.env 에 저장합니다 (git 에 올라가지 않음).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent
$rt = Join-Path $root '.runtime'
$dl = Join-Path $rt 'downloads'
$neoVersion = '5.26.0'

if (-not (Get-ChildItem (Join-Path $rt 'jdk') -Directory -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force (Join-Path $dl 'jdk') | Out-Null
  $meta = Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
  $pkg = $meta[0].binary.package
  $zip = Join-Path $dl "jdk\$($pkg.name)"
  Invoke-WebRequest $pkg.link -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $pkg.checksum.ToLower()) { throw 'JDK SHA-256 불일치' }
  Expand-Archive $zip -DestinationPath (Join-Path $rt 'jdk') -Force
  "JDK 설치: $($pkg.name)"
} else { 'JDK: 이미 설치됨' }

if (-not (Get-ChildItem (Join-Path $rt 'neo4j') -Directory -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force (Join-Path $dl 'neo4j') | Out-Null
  $url = "https://dist.neo4j.org/neo4j-community-$neoVersion-windows.zip"
  $zip = Join-Path $dl "neo4j\neo4j-community-$neoVersion-windows.zip"
  Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
  $sum = (Invoke-WebRequest "$url.sha256" -UseBasicParsing).Content
  if ($sum -is [byte[]]) { $sum = [Text.Encoding]::ASCII.GetString($sum) }
  $expected = ([string]$sum -split '\s+')[0].Trim().ToLower()
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Neo4j SHA-256 불일치' }
  Expand-Archive $zip -DestinationPath (Join-Path $rt 'neo4j') -Force
  "Neo4j 설치: $neoVersion"
} else { 'Neo4j: 이미 설치됨' }

$envFile = Join-Path $root 'backend\.env'
if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^PRISM_NEO4J_PASSWORD=' -Quiet)) {
  'backend\.env: Neo4j 설정이 이미 있음 (비밀번호 변경 안 함)'
  return
}
$bytes = New-Object byte[] 18
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pw = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$jdk = Get-ChildItem (Join-Path $rt 'jdk') -Directory | Select-Object -First 1
$neo = Get-ChildItem (Join-Path $rt 'neo4j') -Directory | Select-Object -First 1
$env:JAVA_HOME = $jdk.FullName
& (Join-Path $neo.FullName 'bin\neo4j-admin.bat') dbms set-initial-password $pw | Out-Null
Add-Content -Path $envFile -Encoding utf8 -Value "PRISM_NEO4J_URI=bolt://127.0.0.1:7687`nPRISM_NEO4J_USER=neo4j`nPRISM_NEO4J_PASSWORD=$pw"
'Neo4j 초기 비밀번호를 설정하고 backend\.env 에 저장했습니다. 실행: .\scripts\neo4j.ps1'
