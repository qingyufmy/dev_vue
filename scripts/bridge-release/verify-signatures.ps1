param([Parameter(Mandatory=$true)][string]$Manifest, [Parameter(Mandatory=$true)][string]$Artifacts, [Parameter(Mandatory=$true)][string]$PublicKey, [string]$Result)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation verify-signatures -Manifest $Manifest -Artifacts $Artifacts -PublicKey $PublicKey -Result $Result
