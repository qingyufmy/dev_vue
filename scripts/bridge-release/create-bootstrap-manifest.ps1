param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$Output,
  [ValidateRange(90,730)][int]$ValidityDays = 365,
  [string]$ReleaseId,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation create-bootstrap-manifest -Manifest $Manifest -Output $Output -ValidityDays $ValidityDays -ReleaseId $ReleaseId -Result $Result
