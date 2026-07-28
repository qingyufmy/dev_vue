param([switch]$SkipNode, [switch]$SkipPython)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dotnet = if ($env:AURUM_DOTNET_EXE) { $env:AURUM_DOTNET_EXE } elseif (Get-Command dotnet -ErrorAction SilentlyContinue) { 'dotnet' } else { Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe' }
& $dotnet test (Join-Path $repo 'bridge\AurumBridge.slnx') -c Release --no-restore
if ($LASTEXITCODE -ne 0) { throw 'release_dotnet_tests_failed' }
if (-not $SkipPython) { & (Join-Path $repo '.venv-bridge\Scripts\python.exe') -m unittest discover -s (Join-Path $repo 'bridge\adapters\mt5-python\tests') -p 'test_*.py'; if ($LASTEXITCODE -ne 0) { throw 'release_python_tests_failed' } }
if (-not $SkipNode) { npm --prefix $repo test; if ($LASTEXITCODE -ne 0) { throw 'release_node_tests_failed' } }
[pscustomobject]@{ ok=$true; operation='test' } | ConvertTo-Json
