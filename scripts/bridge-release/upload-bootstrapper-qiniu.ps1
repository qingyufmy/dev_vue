param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Metadata,
  [ValidateSet('test','production')][string]$TargetEnvironment = 'test',
  [string]$CdnOrigin,
  [switch]$DryRun,
  [string]$Result
)
if ($TargetEnvironment -eq 'production') {
  $signature = Get-AuthenticodeSignature -LiteralPath ([IO.Path]::GetFullPath($Executable))
  if ($signature.Status -ne 'Valid') { throw 'bootstrap_authenticode_signature_invalid' }
}
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation upload-bootstrapper `
  -Executable $Executable -Metadata $Metadata -TargetEnvironment $TargetEnvironment `
  -CdnOrigin $CdnOrigin -DryRun:$DryRun -Result $Result
