param(
  [ValidateSet('test','production')][string]$Environment='test',
  [ValidateSet('environment','database')][string]$QiniuConfigSource='environment',
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
$publicKeyPathValid = [bool]($env:BRIDGE_RELEASE_PUBLIC_KEY_PATH -and
  (Test-Path -LiteralPath $env:BRIDGE_RELEASE_PUBLIC_KEY_PATH -PathType Leaf))
$publicKeyMatchesSigner = $false
if ($signerSelfTestValid -and $publicKeyPathValid) {
  $exportedPublicKey = Join-Path ([IO.Path]::GetTempPath()) "aurum-release-public-key-$([Guid]::NewGuid().ToString('N')).pem"
  try {
    $null = & $env:AURUM_BRIDGE_SIGNER_EXE export-public-key --output $exportedPublicKey 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $exportedPublicKey -PathType Leaf)) {
      $configuredPublicKey = (Get-Content -LiteralPath $env:BRIDGE_RELEASE_PUBLIC_KEY_PATH -Raw) -replace '\s', ''
      $actualPublicKey = (Get-Content -LiteralPath $exportedPublicKey -Raw) -replace '\s', ''
      $publicKeyMatchesSigner = $configuredPublicKey -ceq $actualPublicKey
    }
  } finally {
    Remove-Item -LiteralPath $exportedPublicKey -Force -ErrorAction SilentlyContinue
  }
}
$authenticodeCertificateValid = $false
if ($env:AURUM_AUTHENTICODE_CERT_THUMBPRINT) {
  $normalizedAuthenticodeThumbprint = ($env:AURUM_AUTHENTICODE_CERT_THUMBPRINT -replace '[^a-fA-F0-9]', '').ToUpperInvariant()
  $authenticodeCertificateValid = [bool](Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue | Where-Object {
    $_.Thumbprint -eq $normalizedAuthenticodeThumbprint -and $_.HasPrivateKey -and
    $_.NotAfter -gt (Get-Date) -and
    $_.EnhancedKeyUsageList.ObjectId.Value -contains '1.3.6.1.5.5.7.3.3'
  } | Select-Object -First 1)
}
$qiniuValid = [bool]($env:QINIU_ACCESS_KEY -and $env:QINIU_SECRET_KEY -and
  $env:QINIU_BUCKET -and $env:QINIU_DOMAIN -and $env:QINIU_REGION)
if ($QiniuConfigSource -eq 'database') {
  try {
    $qiniuCheckOutput = & (Join-Path $PSScriptRoot 'verify-qiniu-access.ps1') `
      -QiniuConfigSource database 2>$null
    $qiniuCheck = ($qiniuCheckOutput -join '') | ConvertFrom-Json
    $qiniuValid = $LASTEXITCODE -eq 0 -and $qiniuCheck.ok -eq $true -and
      $qiniuCheck.bucket_accessible -eq $true
  } catch {
    $qiniuValid = $false
  }
}
$checks = [ordered]@{
  dotnet = [bool]($env:AURUM_DOTNET_EXE -or (Get-Command dotnet -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe')))
  node = [bool](Get-Command node -ErrorAction SilentlyContinue)
  signer = $signerPathValid
  signing_certificate = $signerSelfTestValid
  authenticode_certificate = $authenticodeCertificateValid
  public_key = $publicKeyMatchesSigner
  qiniu = $qiniuValid
  endpoint = [bool]($env:AURUM_BRIDGE_RELEASE_API_TOKEN -and $Server -and $Server.StartsWith('https://'))
  python_runtime = [bool]$pythonRuntimeValid
  metaeditor = [bool]($env:AURUM_METAEDITOR_EXE -and (Test-Path -LiteralPath $env:AURUM_METAEDITOR_EXE -PathType Leaf))
}
$missingRequirements = @()
if (-not $checks.signer) { $missingRequirements += 'AURUM_BRIDGE_SIGNER_EXE' }
elseif (-not $checks.signing_certificate) { $missingRequirements += 'AURUM_BRIDGE_SIGNING_CERT_THUMBPRINT' }
if (-not $checks.public_key) { $missingRequirements += 'BRIDGE_RELEASE_PUBLIC_KEY_PATH' }
if (-not $checks.authenticode_certificate) { $missingRequirements += 'AURUM_AUTHENTICODE_CERT_THUMBPRINT' }
if ($QiniuConfigSource -eq 'database') {
  if (-not $checks.qiniu) { $missingRequirements += 'QINIU_DATABASE_CONFIGURATION' }
} else {
  foreach ($name in @('QINIU_ACCESS_KEY','QINIU_SECRET_KEY','QINIU_BUCKET','QINIU_DOMAIN','QINIU_REGION')) {
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) { $missingRequirements += $name }
  }
}
if (-not $env:AURUM_BRIDGE_RELEASE_API_TOKEN) { $missingRequirements += 'AURUM_BRIDGE_RELEASE_API_TOKEN' }
if (-not $Server) { $missingRequirements += 'RELEASE_SERVER_HTTPS_URL' }
elseif (-not $Server.StartsWith('https://')) { $missingRequirements += 'RELEASE_SERVER_HTTPS_REQUIRED' }
if (-not $checks.python_runtime) { $missingRequirements += 'PYTHON_RUNTIME_DIRECTORY' }
if (-not $checks.metaeditor) { $missingRequirements += 'AURUM_METAEDITOR_EXE' }
if (-not $checks.dotnet -or -not $checks.node) { throw 'release_build_runtime_missing' }
if ($Environment -eq 'production' -and (-not $checks.signer -or -not $checks.signing_certificate -or -not $checks.authenticode_certificate -or -not $checks.public_key -or -not $checks.qiniu -or -not $checks.endpoint -or -not $checks.python_runtime -or -not $checks.metaeditor)) {
  throw 'release_production_prerequisite_missing'
}
[pscustomobject]@{
  ok=$true
  operation='preflight'
  environment=$Environment
  qiniu_config_source=$QiniuConfigSource
  dry_run=[bool]$DryRun
  branch=$branch
  commit=$commit
  dirty=$dirty
  checks=$checks
  missing_requirements=@($missingRequirements | Select-Object -Unique)
} | ConvertTo-Json -Depth 5
