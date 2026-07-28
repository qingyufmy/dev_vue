param([Parameter(Mandatory=$true)][string]$Manifest, [string]$Result)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation verify-remote -Manifest $Manifest -Result $Result
