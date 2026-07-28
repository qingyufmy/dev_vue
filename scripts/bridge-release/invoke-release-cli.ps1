param(
  [Parameter(Mandatory=$true)][ValidateSet('sign','verify-signatures','upload','upload-bootstrapper','verify-qiniu-access','verify-remote','verify-bootstrapper-remote','verify-endpoint','publish','stop','rollback','health','promote-bootstrap','rollback-bootstrap','verify-bootstrap','create-bootstrap-manifest')][string]$Operation,
  [string]$Manifest,
  [string]$Artifacts,
  [string]$Signer,
  [string]$PublicKey,
  [string]$Output,
  [string]$Executable,
  [string]$Metadata,
  [string]$CdnOrigin,
  [ValidateSet('test','production')][string]$TargetEnvironment,
  [ValidateSet('environment','database')][string]$QiniuConfigSource = 'environment',
  [string]$InstallerUrl,
  [string]$Server,
  [string]$InstallationId,
  [ValidateSet('internal','stable')][string]$ReleaseChannel,
  [ValidateRange(30,600)][int]$FreshnessSeconds = 90,
  [ValidateRange(90,730)][int]$ValidityDays = 365,
  [string]$ReleaseId,
  [switch]$DryRun,
  [string]$Result
)
$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'release-cli.mjs'
$arguments = @($tool, $Operation)
if ($Operation -in @('upload','upload-bootstrapper','verify-qiniu-access')) {
  $arguments += @('--qiniu-config-source', $QiniuConfigSource)
}
if ($Server) {
  if ($Manifest) { $arguments += @('--manifest', [IO.Path]::GetFullPath($Manifest)) }
  $arguments += @('--server', $Server)
  if ($InstallationId) { $arguments += @('--installation-id', $InstallationId) }
  if ($ReleaseChannel) { $arguments += @('--release-channel', $ReleaseChannel) }
  if ($Operation -eq 'health') { $arguments += @('--freshness-seconds', [string]$FreshnessSeconds) }
  if ($DryRun) { $arguments += @('--dry-run', 'true') }
  if ($Result) { $arguments += @('--result', [IO.Path]::GetFullPath($Result)) }
} else {
  foreach ($pair in @(@('manifest',$Manifest), @('artifacts',$Artifacts), @('signer',$Signer), @('public-key',$PublicKey), @('output',$Output), @('executable',$Executable), @('metadata',$Metadata), @('result',$Result))) {
    if ($pair[1]) { $arguments += @("--$($pair[0])", [IO.Path]::GetFullPath($pair[1])) }
  }
  if ($Operation -eq 'create-bootstrap-manifest') {
    $arguments += @('--validity-days', [string]$ValidityDays)
    if ($ReleaseId) { $arguments += @('--release-id', $ReleaseId) }
  }
  if ($CdnOrigin) { $arguments += @('--cdn-origin', $CdnOrigin) }
  if ($TargetEnvironment) { $arguments += @('--target-environment', $TargetEnvironment) }
  if ($InstallerUrl) { $arguments += @('--installer-url', $InstallerUrl) }
  if ($DryRun) { $arguments += @('--dry-run', 'true') }
}
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "release_$($Operation.Replace('-','_'))_failed" }
