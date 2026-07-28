param([Parameter(Mandatory=$true)][string]$SignedManifest, [Parameter(Mandatory=$true)][string]$Server, [switch]$DryRun, [string]$Result)
# The rollout percentage is signed policy. Generate and sign the expanded Manifest first;
# this command only publishes that already signed replacement.
& (Join-Path $PSScriptRoot 'publish-manifest.ps1') -Manifest $SignedManifest -Server $Server -DryRun:$DryRun -Result $Result
