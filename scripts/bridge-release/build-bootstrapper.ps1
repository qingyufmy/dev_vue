param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [string]$LauncherVersion = '1.0.0',
  [ValidateSet('test','production')][string]$TargetEnvironment = 'test',
  [string]$AuthenticodeCertificateThumbprint = $env:AURUM_AUTHENTICODE_CERT_THUMBPRINT,
  [string]$TimestampServer = 'http://timestamp.digicert.com',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
$publicKeyPath = (Resolve-Path -LiteralPath $PublicKey).Path
$uri = $null
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$uri) -or
  $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
  throw 'bootstrap_server_url_invalid'
}
$parsedLauncherVersion = $null
if (-not [Version]::TryParse($LauncherVersion, [ref]$parsedLauncherVersion)) {
  throw 'bootstrap_launcher_version_invalid'
}
$publicKeyText = Get-Content -LiteralPath $publicKeyPath -Raw
if ($publicKeyText -notmatch '-----BEGIN PUBLIC KEY-----' -or
  $publicKeyText -notmatch '-----END PUBLIC KEY-----') {
  throw 'bootstrap_public_key_invalid'
}
if (Test-Path -LiteralPath $output) { throw 'bootstrap_output_exists' }
if ($TargetEnvironment -eq 'production' -and (git -C $repo status --porcelain)) {
  throw 'bootstrap_production_worktree_dirty'
}
if ($TargetEnvironment -eq 'production' -and -not $AuthenticodeCertificateThumbprint) {
  throw 'bootstrap_authenticode_certificate_required'
}
if ($DryRun) {
  [pscustomobject]@{
    ok=$true; operation='build-bootstrapper'; dry_run=$true
    environment=$TargetEnvironment; output=$output; server=$uri.GetLeftPart([UriPartial]::Authority)
    launcher_version=$LauncherVersion
  } | ConvertTo-Json
  exit 0
}

$dotnet = if ($env:AURUM_DOTNET_EXE) { $env:AURUM_DOTNET_EXE } elseif (Get-Command dotnet -ErrorAction SilentlyContinue) { 'dotnet' } else { Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe' }
$work = Join-Path ([IO.Path]::GetTempPath()) "aurum-bootstrap-build-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null
New-Item -ItemType Directory -Path $output | Out-Null
$succeeded = $false
try {
  $launcher = Join-Path $work 'launcher'
  & $dotnet publish (Join-Path $repo 'bridge\launcher\AurumBridge.Launcher\AurumBridge.Launcher.csproj') `
    -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true `
    -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=None -p:DebugSymbols=false -p:Version=$LauncherVersion -o $launcher
  if ($LASTEXITCODE -ne 0) { throw 'bootstrap_launcher_publish_failed' }
  $launcherExecutable = Join-Path $launcher 'AURUMBridge.Launcher.exe'
  if (-not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) { throw 'bootstrap_launcher_publish_failed' }
  $launcherProductVersion = (Get-Item -LiteralPath $launcherExecutable).VersionInfo.ProductVersion
  $launcherFileVersion = $null
  if (-not [Version]::TryParse(($launcherProductVersion -split '[+-]')[0], [ref]$launcherFileVersion) -or
    $launcherFileVersion.Major -ne $parsedLauncherVersion.Major -or
    $launcherFileVersion.Minor -ne $parsedLauncherVersion.Minor -or
    $launcherFileVersion.Build -ne $parsedLauncherVersion.Build) {
      throw 'bootstrap_launcher_version_mismatch'
    }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $launcherZip = Join-Path $work 'launcher.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $launcher,
    $launcherZip,
    [IO.Compression.CompressionLevel]::Optimal,
    $false)

  $publish = Join-Path $work 'bootstrapper'
  & $dotnet publish (Join-Path $repo 'bridge\bootstrapper\AurumBridge.Bootstrapper\AurumBridge.Bootstrapper.csproj') `
    -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true `
    -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    "-p:AurumBootstrapLauncherZip=$launcherZip" `
    "-p:AurumBootstrapPublicKey=$publicKeyPath" `
    "-p:AurumServerUrl=$($uri.GetLeftPart([UriPartial]::Authority))" `
    "-p:AurumLauncherVersion=$LauncherVersion" `
    -o $publish
  if ($LASTEXITCODE -ne 0) { throw 'bootstrap_publish_failed' }
  $executable = Join-Path $publish 'LiangjianBridgeSetup.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'bootstrap_publish_failed' }
  $destination = Join-Path $output 'LiangjianBridgeSetup.exe'
  Copy-Item -LiteralPath $executable -Destination $destination

  $authenticodeSigned = $false
  if ($AuthenticodeCertificateThumbprint) {
    $normalizedThumbprint = ($AuthenticodeCertificateThumbprint -replace '[^a-fA-F0-9]', '').ToUpperInvariant()
    $certificate = Get-ChildItem Cert:\CurrentUser\My | Where-Object {
      $_.Thumbprint -eq $normalizedThumbprint -and $_.HasPrivateKey -and
      $_.EnhancedKeyUsageList.ObjectId.Value -contains '1.3.6.1.5.5.7.3.3'
    } | Select-Object -First 1
    if (-not $certificate) { throw 'bootstrap_authenticode_certificate_invalid' }
    $signature = Set-AuthenticodeSignature -FilePath $destination -Certificate $certificate -TimestampServer $TimestampServer -HashAlgorithm SHA256
    if ($signature.Status -ne 'Valid') { throw 'bootstrap_authenticode_signing_failed' }
    $authenticodeSigned = $true
  }
  if ($TargetEnvironment -eq 'production' -and -not $authenticodeSigned) {
    throw 'bootstrap_authenticode_signing_required'
  }

  $metadata = [ordered]@{
    schema_version=1
    environment=$TargetEnvironment
    git_commit=(git -C $repo rev-parse HEAD)
    server=$uri.GetLeftPart([UriPartial]::Authority)
    launcher_version=$LauncherVersion
    launcher_zip_sha256=(Get-FileHash -LiteralPath $launcherZip -Algorithm SHA256).Hash.ToLowerInvariant()
    public_key_sha256=(Get-FileHash -LiteralPath $publicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    installer_size_bytes=(Get-Item -LiteralPath $destination).Length
    installer_sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticode_signed=$authenticodeSigned
    generated_at_utc=(Get-Date).ToUniversalTime().ToString('o')
  }
  [IO.File]::WriteAllText(
    (Join-Path $output 'bootstrapper-metadata.json'),
    ($metadata | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false))
  $succeeded = $true
  [pscustomobject]@{
    ok=$true; operation='build-bootstrapper'; output=$output
    executable=$destination; sha256=$metadata.installer_sha256
    authenticode_signed=$authenticodeSigned
  } | ConvertTo-Json
}
finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  if (-not $succeeded -and (Test-Path -LiteralPath $output)) { Remove-Item -LiteralPath $output -Recurse -Force }
}
