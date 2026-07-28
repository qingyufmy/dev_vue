param(
  [Parameter(Mandatory=$true)][string]$SourcePythonRoot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$RequirementsLock,
  [string]$WheelhouseDirectory,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = (Resolve-Path -LiteralPath $SourcePythonRoot).Path
$sourcePython = Join-Path $source 'python.exe'
if (-not (Test-Path -LiteralPath $sourcePython -PathType Leaf)) { throw 'release_python_source_invalid' }
if ((Test-Path -LiteralPath (Join-Path $source 'pyvenv.cfg')) -or
  (Test-Path -LiteralPath (Join-Path (Split-Path $source -Parent) 'pyvenv.cfg'))) { throw 'release_python_source_is_venv' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'release_python_output_exists' }
$lock = if ($RequirementsLock) { (Resolve-Path -LiteralPath $RequirementsLock).Path } else { Join-Path $repo 'bridge\adapters\mt5-python\requirements.lock.txt' }
if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) { throw 'release_python_requirements_lock_missing' }
$wheelhouse = if ($WheelhouseDirectory) { (Resolve-Path -LiteralPath $WheelhouseDirectory).Path } else { $null }
$runtimeInfo = (& $sourcePython -c "import json,platform,sys; print(json.dumps({'version':platform.python_version(),'architecture':platform.architecture()[0],'implementation':platform.python_implementation(),'major':sys.version_info.major,'minor':sys.version_info.minor}))") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $runtimeInfo.implementation -ne 'CPython' -or $runtimeInfo.major -ne 3 -or $runtimeInfo.minor -ne 11 -or $runtimeInfo.architecture -ne '64bit') { throw 'release_python_source_unsupported' }
if ($DryRun) {
  [pscustomobject]@{ ok=$true; operation='build-python-runtime'; dry_run=$true; source=$source; output=$output; version=$runtimeInfo.version; requirements_lock=$lock; wheelhouse=$wheelhouse } | ConvertTo-Json
  exit 0
}
New-Item -ItemType Directory -Path $output | Out-Null
try {
  Get-ChildItem -LiteralPath $source -File -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $output }
  Copy-Item -LiteralPath (Join-Path $source 'DLLs') -Destination (Join-Path $output 'DLLs') -Recurse
  $targetLib = Join-Path $output 'Lib'
  New-Item -ItemType Directory -Path $targetLib | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $source 'Lib') -Force |
    Where-Object { $_.Name -notin @('site-packages','__pycache__') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $targetLib -Recurse }
  $sitePackages = Join-Path $targetLib 'site-packages'
  New-Item -ItemType Directory -Path $sitePackages | Out-Null
  $pipArguments = @('-m','pip','install','--disable-pip-version-check','--no-compile','--require-hashes','--only-binary=:all:','--requirement',$lock,'--target',$sitePackages)
  if ($wheelhouse) { $pipArguments += @('--no-index','--find-links',$wheelhouse) }
  & $sourcePython @pipArguments
  if ($LASTEXITCODE -ne 0) { throw 'release_python_dependency_install_failed' }
  $smoke = (& (Join-Path $output 'python.exe') -I -c "import json,MetaTrader5,numpy,platform; print(json.dumps({'python':platform.python_version(),'mt5':MetaTrader5.__version__,'numpy':numpy.__version__}))") | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $smoke.mt5 -ne '5.0.5735' -or $smoke.numpy -ne '2.4.6') { throw 'release_python_runtime_smoke_test_failed' }
  $metadata = [ordered]@{
    schema_version=1
    python_version=$smoke.python
    architecture='win-x64'
    metatrader5_version=$smoke.mt5
    numpy_version=$smoke.numpy
    requirements_sha256=(Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash.ToLowerInvariant()
    built_at_utc_msc=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  Write-Utf8NoBom -Path (Join-Path $output 'runtime-metadata.json') -Content ($metadata | ConvertTo-Json)
  [pscustomobject]@{ ok=$true; operation='build-python-runtime'; output=$output; metadata=$metadata } | ConvertTo-Json -Depth 5
} catch {
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
  throw
}
