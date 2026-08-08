param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$Server,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation verify-bootstrap -Manifest $Manifest -Server $Server -Result $Result
