param(
  [ValidateSet('test','production')][string]$Environment='test',
  [string]$Server,
  [string]$PythonRuntimeDirectory,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$branch = git -C $repo branch --show-current
$commit = git -C $repo rev-parse HEAD
$dirty = [bool](git -C $repo status --porcelain)
if ($Environment -eq 'production' -and $dirty) { throw 'release_production_worktree_dirty' }
$pythonRuntimeValid = $false
if ($PythonRuntimeDirectory) {
  try {
    $pythonRuntimeRoot = (Resolve-Path -LiteralPath $PythonRuntimeDirectory).Path
    $pythonRuntimeValid = (Test-Path -LiteralPath (Join-Path $pythonRuntimeRoot 'python.exe') -PathType Leaf) -and
      -not (Test-Path -LiteralPath (Join-Path $pythonRuntimeRoot 'pyvenv.cfg')) -and
      -not (Test-Path -LiteralPath (Join-Path (Split-Path $pythonRuntimeRoot -Parent) 'pyvenv.cfg'))
  } catch {
    $pythonRuntimeValid = $false
  }
}
$signerPathValid = [bool]($env:AURUM_BRIDGE_SIGNER_EXE -and (Test-Path -LiteralPath $env:AURUM_BRIDGE_SIGNER_EXE -PathType Leaf))
$signerSelfTestValid = $false
if ($signerPathValid) {
  $signerSelfTestOutput = & $env:AURUM_BRIDGE_SIGNER_EXE self-test 2>$null
  $signerSelfTestValid = $LASTEXITCODE -eq 0 -and ($signerSelfTestOutput -join '') -match '"ok"\s*:\s*true'
}
$checks = [ordered]@{
  dotnet = [bool]($env:AURUM_DOTNET_EXE -or (Get-Command dotnet -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe')))
  node = [bool](Get-Command node -ErrorAction SilentlyContinue)
  signer = $signerPathValid
  signing_certificate = $signerSelfTestValid
  public_key = [bool]($env:BRIDGE_RELEASE_PUBLIC_KEY_PATH -and (Test-Path -LiteralPath $env:BRIDGE_RELEASE_PUBLIC_KEY_PATH -PathType Leaf))
  qiniu = [bool]($env:QINIU_ACCESS_KEY -and $env:QINIU_SECRET_KEY -and $env:QINIU_BUCKET -and $env:QINIU_DOMAIN -and $env:QINIU_REGION)
  endpoint = [bool]($env:AURUM_BRIDGE_RELEASE_API_TOKEN -and $Server -and $Server.StartsWith('https://'))
  python_runtime = [bool]$pythonRuntimeValid
  metaeditor = [bool]($env:AURUM_METAEDITOR_EXE -and (Test-Path -LiteralPath $env:AURUM_METAEDITOR_EXE -PathType Leaf))
}
$missingRequirements = @()
if (-not $checks.signer) { $missingRequirements += 'AURUM_BRIDGE_SIGNER_EXE' }
elseif (-not $checks.signing_certificate) { $missingRequirements += 'AURUM_BRIDGE_SIGNING_CERT_THUMBPRINT' }
if (-not $checks.public_key) { $missingRequirements += 'BRIDGE_RELEASE_PUBLIC_KEY_PATH' }
foreach ($name in @('QINIU_ACCESS_KEY','QINIU_SECRET_KEY','QINIU_BUCKET','QINIU_DOMAIN','QINIU_REGION')) {
  if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) { $missingRequirements += $name }
}
if (-not $env:AURUM_BRIDGE_RELEASE_API_TOKEN) { $missingRequirements += 'AURUM_BRIDGE_RELEASE_API_TOKEN' }
if (-not $Server) { $missingRequirements += 'RELEASE_SERVER_HTTPS_URL' }
elseif (-not $Server.StartsWith('https://')) { $missingRequirements += 'RELEASE_SERVER_HTTPS_REQUIRED' }
if (-not $checks.python_runtime) { $missingRequirements += 'PYTHON_RUNTIME_DIRECTORY' }
if (-not $checks.metaeditor) { $missingRequirements += 'AURUM_METAEDITOR_EXE' }
if (-not $checks.dotnet -or -not $checks.node) { throw 'release_build_runtime_missing' }
if ($Environment -eq 'production' -and (-not $checks.signer -or -not $checks.signing_certificate -or -not $checks.public_key -or -not $checks.qiniu -or -not $checks.endpoint -or -not $checks.python_runtime -or -not $checks.metaeditor)) {
  throw 'release_production_prerequisite_missing'
}
[pscustomobject]@{
  ok=$true
  operation='preflight'
  environment=$Environment
  dry_run=[bool]$DryRun
  branch=$branch
  commit=$commit
  dirty=$dirty
  checks=$checks
  missing_requirements=@($missingRequirements | Select-Object -Unique)
} | ConvertTo-Json -Depth 5
