param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$FirstManifest,
  [Parameter(Mandatory=$true)][string]$SecondManifest,
  [Parameter(Mandatory=$true)][string]$ExpectedServerUrl,
  [Parameter(Mandatory=$true)][string]$InitialVersion,
  [string]$Result
)
$ErrorActionPreference = 'Stop'
if (-not $env:AURUM_BRIDGE_RELEASE_API_TOKEN -or $env:AURUM_BRIDGE_RELEASE_API_TOKEN.Length -lt 32) {
  throw 'update_rehearsal_release_token_invalid'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nativeRoot = Join-Path $repo 'bridge\native'
$cargo = if (Get-Command cargo -ErrorAction SilentlyContinue) {
  'cargo'
} else {
  Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
Push-Location $nativeRoot
try {
  & $cargo build --locked --release --target x86_64-pc-windows-msvc `
    -p liangjian-bridge-launcher -p liangjian-bridge-update-rehearsal
  if ($LASTEXITCODE -ne 0) { throw 'update_rehearsal_native_build_failed' }
} finally {
  Pop-Location
}
$releaseRoot = Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\release'
$rehearsal = Join-Path $releaseRoot 'liangjian-bridge-update-rehearsal.exe'
$launcher = Join-Path $releaseRoot 'liangjian-bridge-launcher.exe'
if (-not (Test-Path -LiteralPath $rehearsal -PathType Leaf) -or
  -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw 'update_rehearsal_native_build_missing'
}
$previousDataDirectory = $env:AURUM_BRIDGE_DATA_DIR
try {
  $env:AURUM_BRIDGE_DATA_DIR = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'rehearsal-data'))
  $rehearsalOutput = @(& $rehearsal `
  --server $Server `
  --public-key $PublicKey `
  --launcher $launcher `
  --install-root $InstallRoot `
  --first-manifest $FirstManifest `
  --second-manifest $SecondManifest `
  --expected-server-url $ExpectedServerUrl `
  --initial-version $InitialVersion)
  $rehearsalExitCode = $LASTEXITCODE
} finally {
  $env:AURUM_BRIDGE_DATA_DIR = $previousDataDirectory
}
$resultJson = if ($rehearsalOutput.Count -gt 0) { [string]$rehearsalOutput[-1] } else { '' }
try {
  $resultDocument = $resultJson | ConvertFrom-Json
} catch {
  throw 'update_rehearsal_result_invalid'
}
if ($resultDocument.operation -ne 'client-update-rehearsal' -or
  $resultDocument.ok -isnot [bool] -or
  (($rehearsalExitCode -eq 0) -ne [bool]$resultDocument.ok)) {
  throw 'update_rehearsal_result_invalid'
}
if ($resultDocument.ok) {
  $expectedPhases = @('waiting_window','acquiring_lease','draining','activating')
  $observedPhases = @($resultDocument.interrupted_recovery.phases)
  if ($resultDocument.interrupted_recovery.mode -ne 'real-child-process-termination' -or
    $observedPhases.Count -ne $expectedPhases.Count) {
    throw 'update_rehearsal_process_kill_evidence_missing'
  }
  for ($index = 0; $index -lt $expectedPhases.Count; $index++) {
    $phase = $observedPhases[$index]
    if ([string]$phase.phase -ne $expectedPhases[$index] -or
      -not [bool]$phase.process_terminated -or
      -not [bool]$phase.restart_recovered -or
      -not [bool]$phase.stage_reverified -or
      -not [bool]$phase.maintenance_lease_cleared -or
      -not [bool]$phase.active_version_unchanged) {
      throw 'update_rehearsal_process_kill_evidence_invalid'
    }
  }
}
if ($Result) {
  $resultPath = [IO.Path]::GetFullPath($Result)
  $resultDirectory = Split-Path $resultPath -Parent
  if (-not (Test-Path -LiteralPath $resultDirectory -PathType Container)) {
    throw 'update_rehearsal_result_directory_missing'
  }
  [IO.File]::WriteAllText($resultPath, $resultJson, [Text.UTF8Encoding]::new($false))
}
Write-Output $resultJson
exit $rehearsalExitCode
