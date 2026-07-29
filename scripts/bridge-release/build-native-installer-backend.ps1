param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [string]$LauncherVersion = '1.0.0',
  [ValidateSet('test','production')][string]$TargetEnvironment = 'test',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
$publicKeyPath = (Resolve-Path -LiteralPath $PublicKey).Path
$parsedLauncherVersion = $null
if (-not [Version]::TryParse($LauncherVersion, [ref]$parsedLauncherVersion)) {
  throw 'native_installer_launcher_version_invalid'
}
$publicKeyText = Get-Content -LiteralPath $publicKeyPath -Raw
if ($publicKeyText -notmatch '-----BEGIN PUBLIC KEY-----' -or
  $publicKeyText -notmatch '-----END PUBLIC KEY-----') {
  throw 'native_installer_public_key_invalid'
}
if (Test-Path -LiteralPath $output) { throw 'native_installer_output_exists' }
if ($TargetEnvironment -eq 'production' -and (git -C $repo status --porcelain)) {
  throw 'native_installer_production_worktree_dirty'
}
if ($DryRun) {
  [pscustomobject]@{
    ok=$true
    operation='build-native-installer-backend'
    dry_run=$true
    environment=$TargetEnvironment
    output=$output
    launcher_version=$LauncherVersion
    public_key_sha256=(Get-FileHash -LiteralPath $publicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  } | ConvertTo-Json
  exit 0
}

$cargo = if (Get-Command cargo -ErrorAction SilentlyContinue) {
  (Get-Command cargo).Source
} else {
  Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
  throw 'native_installer_cargo_missing'
}
$env:AURUM_INSTALLER_PUBLIC_KEY_PATH = $publicKeyPath
$env:AURUM_INSTALLER_LAUNCHER_VERSION = $LauncherVersion
$env:AURUM_INSTALLER_TARGET_ENVIRONMENT = $TargetEnvironment
& $cargo build --locked --release --target x86_64-pc-windows-msvc `
  -p liangjian-bridge-installer --manifest-path (Join-Path $repo 'bridge\native\Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'native_installer_build_failed' }
$source = Join-Path $repo 'bridge\native\target\x86_64-pc-windows-msvc\release\liangjian-bridge-installer.exe'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw 'native_installer_build_output_missing'
}
New-Item -ItemType Directory -Path $output | Out-Null
$destination = Join-Path $output 'LiangjianBridgeInstallBackend.exe'
Copy-Item -LiteralPath $source -Destination $destination
$metadata = [ordered]@{
  schema_version=1
  environment=$TargetEnvironment
  git_commit=(git -C $repo rev-parse HEAD)
  launcher_version=$LauncherVersion
  native_offline_backend=$true
  public_key_sha256=(Get-FileHash -LiteralPath $publicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  backend_size_bytes=(Get-Item -LiteralPath $destination).Length
  backend_sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  generated_at_utc=(Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText(
  (Join-Path $output 'installer-backend-metadata.json'),
  ($metadata | ConvertTo-Json -Depth 5),
  [Text.UTF8Encoding]::new($false))
[pscustomobject]@{
  ok=$true
  operation='build-native-installer-backend'
  output=$output
  executable=$destination
  size_bytes=$metadata.backend_size_bytes
  sha256=$metadata.backend_sha256
} | ConvertTo-Json
