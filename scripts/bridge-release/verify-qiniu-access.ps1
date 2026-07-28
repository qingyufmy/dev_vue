param(
  [ValidateSet('environment','database')][string]$QiniuConfigSource = 'database',
  [switch]$DryRun,
  [string]$Result
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation verify-qiniu-access `
  -QiniuConfigSource $QiniuConfigSource -DryRun:$DryRun -Result $Result
