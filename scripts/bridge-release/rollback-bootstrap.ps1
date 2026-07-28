param(
  [Parameter(Mandatory=$true)][string]$Server,
  [switch]$DryRun,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation rollback-bootstrap -Server $Server -DryRun:$DryRun -Result $Result
