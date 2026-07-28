param([Parameter(Mandatory=$true)][string]$Manifest, [Parameter(Mandatory=$true)][string]$Server, [switch]$DryRun, [string]$Result)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation publish -Manifest $Manifest -Server $Server -DryRun:$DryRun -Result $Result
