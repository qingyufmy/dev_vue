param(
  [Parameter(Mandatory=$true)][ValidateSet('sign','verify-signatures','upload','verify-remote','verify-endpoint','publish','stop','rollback','health')][string]$Operation,
  [string]$Manifest,
  [string]$Artifacts,
  [string]$Signer,
  [string]$PublicKey,
  [string]$Output,
  [string]$Server,
  [string]$InstallationId,
  [ValidateSet('internal','stable')][string]$ReleaseChannel,
  [ValidateRange(30,600)][int]$FreshnessSeconds = 90,
  [switch]$DryRun,
  [string]$Result
)
$ErrorActionPreference = 'Stop'
$tool = Join-Path $PSScriptRoot 'release-cli.mjs'
$arguments = @($tool, $Operation)
if ($Server) {
  if ($Manifest) { $arguments += @('--manifest', [IO.Path]::GetFullPath($Manifest)) }
  $arguments += @('--server', $Server)
  if ($InstallationId) { $arguments += @('--installation-id', $InstallationId) }
  if ($ReleaseChannel) { $arguments += @('--release-channel', $ReleaseChannel) }
  if ($Operation -eq 'health') { $arguments += @('--freshness-seconds', [string]$FreshnessSeconds) }
  if ($DryRun) { $arguments += @('--dry-run', 'true') }
  if ($Result) { $arguments += @('--result', [IO.Path]::GetFullPath($Result)) }
} else {
  foreach ($pair in @(@('manifest',$Manifest), @('artifacts',$Artifacts), @('signer',$Signer), @('public-key',$PublicKey), @('output',$Output), @('result',$Result))) {
    if ($pair[1]) { $arguments += @("--$($pair[0])", [IO.Path]::GetFullPath($pair[1])) }
  }
  if ($DryRun) { $arguments += @('--dry-run', 'true') }
}
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "release_$($Operation.Replace('-','_'))_failed" }
