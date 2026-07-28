param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Metadata,
  [ValidateSet('test','production')][string]$TargetEnvironment = 'test',
  [ValidateSet('environment','database')][string]$QiniuConfigSource = 'environment',
  [string]$CdnOrigin,
  [switch]$AllowUnsignedInstaller,
  [switch]$DryRun,
  [string]$Result
)
if ($AllowUnsignedInstaller -and $TargetEnvironment -ne 'production') {
  throw 'bootstrap_unsigned_installer_confirmation_invalid'
}
if ($TargetEnvironment -eq 'production') {
  $metadataValue = Get-Content -LiteralPath ([IO.Path]::GetFullPath($Metadata)) -Raw | ConvertFrom-Json
  $signature = Get-AuthenticodeSignature -LiteralPath ([IO.Path]::GetFullPath($Executable))
  $authenticodeSigned = $signature.Status -eq 'Valid'
  if ([bool]$metadataValue.authenticode_signed -ne $authenticodeSigned) {
    throw 'bootstrap_authenticode_metadata_mismatch'
  }
  if (-not $authenticodeSigned -and
    (-not $AllowUnsignedInstaller -or $metadataValue.unsigned_installer_authorized -ne $true)) {
    throw 'bootstrap_unsigned_installer_confirmation_required'
  }
}
& (Join-Path $PSScriptRoot 'invoke-release-cli.ps1') -Operation upload-bootstrapper `
  -Executable $Executable -Metadata $Metadata -TargetEnvironment $TargetEnvironment `
  -QiniuConfigSource $QiniuConfigSource -CdnOrigin $CdnOrigin `
  -AllowUnsignedInstaller:$AllowUnsignedInstaller -DryRun:$DryRun -Result $Result
