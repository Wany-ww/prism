# 로컬 Neo4j (Community 5.26) 실행 — .runtime/ 에 설치된 JDK 21 + Neo4j 사용
#   .\scripts\neo4j.ps1          : 콘솔 모드로 실행 (Ctrl+C 로 종료), bolt://127.0.0.1:7687, http://127.0.0.1:7474
param([string]$Command = 'console')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$jdk = Get-ChildItem (Join-Path $root '.runtime\jdk') -Directory | Select-Object -First 1
$neo = Get-ChildItem (Join-Path $root '.runtime\neo4j') -Directory | Select-Object -First 1
if (-not $jdk -or -not $neo) { throw '.runtime 에 JDK/Neo4j 가 없습니다. README 의 Neo4j 설치 절차를 참고하세요.' }
$env:JAVA_HOME = $jdk.FullName
$env:Path = (Join-Path $jdk.FullName 'bin') + ';' + $env:Path
& (Join-Path $neo.FullName 'bin\neo4j.bat') $Command
