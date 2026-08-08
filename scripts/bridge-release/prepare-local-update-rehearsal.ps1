param(
  [Parameter(Mandatory=$true)][string]$FirstReleaseDirectory,
  [Parameter(Mandatory=$true)][string]$SecondReleaseDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$Signer,
  [Parameter(Mandatory=$true)][string]$FirstVersion,
  [Parameter(Mandatory=$true)][string]$SecondVersion,
  [ValidateSet('internal','stable')][string]$ReleaseChannel = 'internal',
  [string]$StaticServerUrl = 'http://127.0.0.1:3102'
)
$ErrorActionPreference = 'Stop'

function Write-Utf8Json([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function New-RehearsalManifest(
  [object]$SourceManifest,
  [string]$Version,
  [string]$Priority,
  [string]$ReleaseId,
  [string]$StaticRoot,
  [string]$Artifacts,
  [long]$NowUtcMsc,
  [long]$ExpiresAtUtcMsc
) {
  $packages = foreach ($sourcePackage in $SourceManifest.packages) {
    $moduleId = [string]$sourcePackage.module_id
    $file = Join-Path $Artifacts "$moduleId.zip"
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw 'update_rehearsal_package_missing'
    }
    $info = Get-Item -LiteralPath $file
    $sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $key = "bridge/releases/$Version/$sha256/$moduleId.zip"
    $destination = Join-Path $StaticRoot ($key -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $file -Destination $destination
    [ordered]@{
      module_id = $moduleId
      version = $Version
      url = "$serverUrlValue/$key"
      size_bytes = [long]$info.Length
      sha256 = $sha256
      signature = ''
      minimum_core_version = if ($moduleId -eq 'core') { $null } else { $Version }
      maximum_core_version = if ($moduleId -eq 'core') { $null } else { $Version }
    }
  }
  [ordered]@{
    schema_version = 2
    release_version = $Version
    release_id = $ReleaseId
    generated_at_utc_msc = $NowUtcMsc
    published_at_utc_msc = $NowUtcMsc
    expires_at_utc_msc = $ExpiresAtUtcMsc
    priority = $Priority
    minimum_launcher_version = [string]$SourceManifest.minimum_launcher_version
    minimum_idle_seconds = [int]$SourceManifest.minimum_idle_seconds
    activation_deadline_utc_msc = $null
    rollout_channel = $ReleaseChannel
    rollout_percentage = 100
    packages = @($packages)
    signature = ''
  }
}

$firstSourceRoot = (Resolve-Path -LiteralPath $FirstReleaseDirectory).Path
$secondSourceRoot = (Resolve-Path -LiteralPath $SecondReleaseDirectory).Path
$publicKeyPath = (Resolve-Path -LiteralPath $PublicKey).Path
$signerPath = (Resolve-Path -LiteralPath $Signer).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'update_rehearsal_output_exists' }
$first = $null
$second = $null
if (-not [Version]::TryParse($FirstVersion, [ref]$first) -or
  -not [Version]::TryParse($SecondVersion, [ref]$second) -or
  $second -le $first -or $FirstVersion.Contains('-') -or $SecondVersion.Contains('-')) {
  throw 'update_rehearsal_version_invalid'
}
$serverUri = $null
if (-not [Uri]::TryCreate($StaticServerUrl, [UriKind]::Absolute, [ref]$serverUri) -or
  $serverUri.Scheme -ne 'http' -or $serverUri.Host -ne '127.0.0.1' -or
  $serverUri.UserInfo -or $serverUri.Query -or $serverUri.Fragment -or
  $serverUri.AbsolutePath -ne '/') {
  throw 'update_rehearsal_static_server_invalid'
}
$serverUrlValue = $serverUri.GetLeftPart([UriPartial]::Authority)
function Read-SourceManifest([string]$Root, [string]$ExpectedVersion) {
  $manifestPath = @('manifest.signed.json','manifest.unsigned.json') |
    ForEach-Object { Join-Path $Root $_ } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
  if (-not $manifestPath) { throw 'update_rehearsal_source_manifest_missing' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $packageVersions = @($manifest.packages | ForEach-Object { [string]$_.version } | Select-Object -Unique)
  if ($manifest.schema_version -ne 2 -or
    [string]$manifest.release_version -ne $ExpectedVersion -or
    $manifest.rollout_channel -notin @('internal','stable') -or
    [int]$manifest.rollout_percentage -ne 100 -or
    [int]$manifest.minimum_idle_seconds -lt 30 -or
    [int]$manifest.minimum_idle_seconds -gt 3600 -or
    $packageVersions.Count -ne 1 -or $packageVersions[0] -ne $ExpectedVersion) {
    throw 'update_rehearsal_source_manifest_invalid'
  }
  return $manifest
}
$firstSourceManifest = Read-SourceManifest $firstSourceRoot $FirstVersion
$secondSourceManifest = Read-SourceManifest $secondSourceRoot $SecondVersion

$firstArtifacts = Join-Path $outputRoot 'artifacts\first'
$secondArtifacts = Join-Path $outputRoot 'artifacts\second'
$staticRoot = Join-Path $outputRoot 'static'
$manifestRoot = Join-Path $outputRoot 'manifests'
New-Item -ItemType Directory -Path $firstArtifacts,$secondArtifacts,$staticRoot,$manifestRoot | Out-Null
foreach ($sourceSet in @(
  [pscustomobject]@{ Root=$firstSourceRoot; Artifacts=$firstArtifacts },
  [pscustomobject]@{ Root=$secondSourceRoot; Artifacts=$secondArtifacts }
)) {
  foreach ($moduleId in @('core','adapter.mt5.python','adapter.mt4')) {
    $source = Join-Path $sourceSet.Root "$moduleId.zip"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw 'update_rehearsal_package_missing'
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $sourceSet.Artifacts "$moduleId.zip")
  }
}
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$expires = [DateTimeOffset]::UtcNow.AddDays(365).ToUnixTimeMilliseconds()
$firstUnsigned = Join-Path $manifestRoot 'first.unsigned.json'
$firstSigned = Join-Path $manifestRoot 'first.signed.json'
$secondUnsigned = Join-Path $manifestRoot 'second.unsigned.json'
$secondSigned = Join-Path $manifestRoot 'second.signed.json'
$firstManifest = New-RehearsalManifest $firstSourceManifest $FirstVersion 'normal' `
  "local-rehearsal-$FirstVersion-normal" $staticRoot $firstArtifacts $now $expires
$secondManifest = New-RehearsalManifest $secondSourceManifest $SecondVersion 'urgent' `
  "local-rehearsal-$SecondVersion-urgent" $staticRoot $secondArtifacts ($now + 1) $expires
Write-Utf8Json $firstUnsigned $firstManifest
Write-Utf8Json $secondUnsigned $secondManifest
$null = & (Join-Path $PSScriptRoot 'sign-release.ps1') `
  -Manifest $firstUnsigned -Output $firstSigned -Signer $signerPath
$null = & (Join-Path $PSScriptRoot 'sign-release.ps1') `
  -Manifest $secondUnsigned -Output $secondSigned -Signer $signerPath
$null = & (Join-Path $PSScriptRoot 'verify-signatures.ps1') `
  -Manifest $firstSigned -Artifacts $firstArtifacts -PublicKey $publicKeyPath
$null = & (Join-Path $PSScriptRoot 'verify-signatures.ps1') `
  -Manifest $secondSigned -Artifacts $secondArtifacts -PublicKey $publicKeyPath
[pscustomobject]@{
  ok = $true
  operation = 'prepare-local-update-rehearsal'
  first_manifest = $firstSigned
  second_manifest = $secondSigned
  static_directory = $staticRoot
  public_key = $publicKeyPath
  first_version = $FirstVersion
  second_version = $SecondVersion
  static_server_url = $serverUrlValue
} | ConvertTo-Json
