param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$InstallationId,
  [Parameter(Mandatory=$true)][ValidateSet('internal','stable')][string]$ReleaseChannel,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation verify-endpoint -Manifest $Manifest -Server $Server -InstallationId $InstallationId -ReleaseChannel $ReleaseChannel -Result $Result
