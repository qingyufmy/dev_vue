param([switch]$SkipNode)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
& (Join-Path $repo 'scripts\bridge-native\test-native.ps1') -SkipRelease
if ($LASTEXITCODE -ne 0) { throw 'release_native_tests_failed' }
if (-not $SkipNode) { npm --prefix $repo test; if ($LASTEXITCODE -ne 0) { throw 'release_node_tests_failed' } }
[pscustomobject]@{ ok=$true; operation='test' } | ConvertTo-Json
