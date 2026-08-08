param([Parameter(Mandatory=$true)][string]$Manifest, [Parameter(Mandatory=$true)][string]$Output, [string]$Signer=$env:AURUM_BRIDGE_SIGNER_EXE, [string]$Result)
if (-not $Signer) { throw 'release_signer_required' }
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation sign -Manifest $Manifest -Output $Output -Signer $Signer -Result $Result
