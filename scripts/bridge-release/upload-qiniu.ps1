param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$Artifacts,
  [ValidateSet('environment','database')][string]$QiniuConfigSource = 'environment',
  [switch]$DryRun,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation upload `
  -Manifest $Manifest -Artifacts $Artifacts -QiniuConfigSource $QiniuConfigSource `
  -DryRun:$DryRun -Result $Result
