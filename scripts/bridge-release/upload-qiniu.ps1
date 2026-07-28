param([Parameter(Mandatory=$true)][string]$Manifest, [Parameter(Mandatory=$true)][string]$Artifacts, [switch]$DryRun, [string]$Result)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation upload -Manifest $Manifest -Artifacts $Artifacts -DryRun:$DryRun -Result $Result
