param(
  [Parameter(Mandatory=$true)][string]$Server,
  [ValidateRange(30,600)][int]$FreshnessSeconds = 90,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation health -Server $Server -FreshnessSeconds $FreshnessSeconds -Result $Result
