param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'release_signer_output_exists' }
if ($DryRun) {
  [pscustomobject]@{ ok=$true; operation='build-signer'; dry_run=$true; output=$output } | ConvertTo-Json
  exit 0
}
$dotnet = if ($env:AURUM_DOTNET_EXE) { $env:AURUM_DOTNET_EXE } elseif (Get-Command dotnet -ErrorAction SilentlyContinue) { 'dotnet' } else { Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe' }
& $dotnet publish (Join-Path $repo 'bridge\tools\AurumBridge.ReleaseSigner\AurumBridge.ReleaseSigner.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $output
if ($LASTEXITCODE -ne 0) { throw 'release_signer_publish_failed' }
$executable = Join-Path $output 'AURUMBridge.ReleaseSigner.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'release_signer_publish_failed' }
[pscustomobject]@{ ok=$true; operation='build-signer'; output=$output; executable=$executable } | ConvertTo-Json
