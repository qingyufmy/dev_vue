param(
  [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
  [string]$WorkerDirectory,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$workerRoot = if ($WorkerDirectory) {
  (Resolve-Path -LiteralPath $WorkerDirectory).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $repo 'bridge\native\workers\mt5')).Path
}
$rootPath = [IO.Path]::GetPathRoot($root)
if ($root -eq $rootPath -or -not (Split-Path $root -Parent) -or
  -not (Test-Path -LiteralPath (Join-Path $root 'python.exe') -PathType Leaf) -or
  -not (Test-Path -LiteralPath (Join-Path $root 'Lib\site-packages') -PathType Container) -or
  -not (Test-Path -LiteralPath (Join-Path $workerRoot 'worker.py') -PathType Leaf) -or
  -not (Test-Path -LiteralPath (Join-Path $workerRoot 'trade.py') -PathType Leaf)) {
  throw 'release_python_runtime_optimization_invalid'
}
$rootPrefix = $root.TrimEnd('\') + '\'

$prunedExtensions = @('.pdb','.d','.rlib','.lib','.exp','.obj','.ilk','.map','.pyc')
$prunedRelativeFiles = @(
  'DLLs\libcrypto-3-x64.dll',
  'DLLs\libssl-3-x64.dll',
  'DLLs\_ssl.pyd',
  'DLLs\_hashlib.pyd',
  'DLLs\tcl86t.dll',
  'DLLs\tk86t.dll',
  'DLLs\_tkinter.pyd',
  'Lib\ssl.py',
  'Lib\turtle.py'
)
$prunedRelativeDirectories = @(
  'Lib\ensurepip',
  'Lib\idlelib',
  'Lib\tkinter',
  'Lib\turtledemo',
  'Lib\venv',
  'Lib\lib2to3',
  'Lib\distutils'
)
$exactFiles = @{}
foreach ($relative in $prunedRelativeFiles) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'release_python_runtime_optimization_invalid'
  }
  $exactFiles[$candidate] = $true
}
$directoryPrefixes = @()
foreach ($relative in $prunedRelativeDirectories) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative)).TrimEnd('\') + '\'
  if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'release_python_runtime_optimization_invalid'
  }
  $directoryPrefixes += $candidate
}

$allFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)
$prunedFiles = @($allFiles | Where-Object {
  $fullName = [IO.Path]::GetFullPath($_.FullName)
  $relative = $fullName.Substring($rootPrefix.Length)
  $inPrunedDirectory = @($directoryPrefixes | Where-Object {
    $fullName.StartsWith($_, [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
  $prunedExtensions -contains $_.Extension.ToLowerInvariant() -or
    $exactFiles.ContainsKey($fullName) -or
    $inPrunedDirectory -or
    $relative -match '(^|\\)__pycache__(\\|$)'
})
$prunedBytes = ($prunedFiles | Measure-Object Length -Sum).Sum

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    operation = 'optimize-python-runtime'
    dry_run = $true
    runtime = $root
    removed_file_count = $prunedFiles.Count
    removed_bytes = [long]$prunedBytes
  } | ConvertTo-Json
  exit 0
}

foreach ($file in $prunedFiles) {
  $path = [IO.Path]::GetFullPath($file.FullName)
  if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'release_python_runtime_optimization_invalid'
  }
  Remove-Item -LiteralPath $path -Force
}
$directories = @(Get-ChildItem -LiteralPath $root -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending)
foreach ($directory in $directories) {
  $path = [IO.Path]::GetFullPath($directory.FullName)
  if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'release_python_runtime_optimization_invalid'
  }
  if (-not (Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $path -Force
  }
}

$python = Join-Path $root 'python.exe'
$smokeCode = @'
import hashlib, importlib.util, json, sys
assert hashlib.sha256(b'aurum').hexdigest() == 'e02346c759d1571ac98c58215b32d16c5e11b881c1d600e1cf24b12075a8544d'
import MetaTrader5
import numpy
sys.path.insert(0, sys.argv[1])
import worker
import trade
ssl_available = importlib.util.find_spec('ssl') is not None
assert not ssl_available
print(json.dumps({'python': sys.version.split()[0], 'mt5': MetaTrader5.__version__, 'numpy': numpy.__version__, 'worker': worker.WORKER_VERSION, 'ssl_available': ssl_available}))
'@
$smokeLines = & $python -I -B -c $smokeCode $workerRoot
if ($LASTEXITCODE -ne 0) { throw 'release_python_runtime_optimization_smoke_failed' }
$smoke = (($smokeLines -join [Environment]::NewLine) | ConvertFrom-Json)
if ($smoke.mt5 -ne '5.0.5735' -or $smoke.numpy -ne '2.4.6' -or $smoke.ssl_available -ne $false) {
  throw 'release_python_runtime_optimization_smoke_failed'
}
[pscustomobject]@{
  ok = $true
  operation = 'optimize-python-runtime'
  runtime = $root
  removed_file_count = $prunedFiles.Count
  removed_bytes = [long]$prunedBytes
  smoke = $smoke
} | ConvertTo-Json -Depth 5
