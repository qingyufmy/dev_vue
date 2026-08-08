param(
  [Parameter(Mandatory=$true)][string]$Metadata,
  [Parameter(Mandatory=$true)][string]$InstallerUrl,
  [string]$Result
)
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation verify-bootstrapper-remote `
  -Metadata $Metadata -InstallerUrl $InstallerUrl -Result $Result
