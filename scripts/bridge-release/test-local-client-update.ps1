param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$FirstManifest,
  [Parameter(Mandatory=$true)][string]$SecondManifest,
  [Parameter(Mandatory=$true)][string]$ExpectedServerUrl,
  [Parameter(Mandatory=$true)][string]$InitialVersion
)
$ErrorActionPreference = 'Stop'
if (-not $env:AURUM_BRIDGE_RELEASE_API_TOKEN -or $env:AURUM_BRIDGE_RELEASE_API_TOKEN.Length -lt 32) {
  throw 'update_rehearsal_release_token_invalid'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dotnet = if ($env:AURUM_DOTNET_EXE) {
  $env:AURUM_DOTNET_EXE
} elseif (Get-Command dotnet -ErrorAction SilentlyContinue) {
  'dotnet'
} else {
  Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe'
}
& $dotnet run --project (Join-Path $repo 'bridge\tools\AurumBridge.UpdateRehearsal\AurumBridge.UpdateRehearsal.csproj') `
  -c Release -- `
  --server $Server `
  --public-key $PublicKey `
  --install-root $InstallRoot `
  --first-manifest $FirstManifest `
  --second-manifest $SecondManifest `
  --expected-server-url $ExpectedServerUrl `
  --initial-version $InitialVersion
exit $LASTEXITCODE
