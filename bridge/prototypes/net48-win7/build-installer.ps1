param(
    [ValidateSet('Online', 'Offline')]
    [string]$Mode = 'Online',
    [string]$OfflineRuntimePath = ''
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = Join-Path $prototypeRoot 'artifacts'
$stagingRoot = Join-Path $artifactsRoot 'installer-staging'
$installerOutputRoot = Join-Path $artifactsRoot 'installer'
$version = '4.0.0.0'
$innoCompiler = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$expectedOfflineHash = '0A3A390C47E639D0F7FC65B21195FEE6B7F65B066F80F70C60FAB191D14B7E40'

if (-not (Test-Path -LiteralPath $innoCompiler)) {
    throw "bridge_inno_compiler_missing: $innoCompiler"
}

& (Join-Path $prototypeRoot 'build.ps1') -Platform x86

$resolvedPrototype = [IO.Path]::GetFullPath($prototypeRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedStaging = [IO.Path]::GetFullPath($stagingRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $resolvedStaging.StartsWith($resolvedPrototype + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "bridge_installer_staging_root_invalid: $resolvedStaging"
}
if (Test-Path -LiteralPath $resolvedStaging) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $resolvedStaging "versions\$version\x86") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $resolvedStaging "versions\$version\launcher") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $artifactsRoot 'AURUMBridge.Launcher.exe') -Destination $resolvedStaging
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.Launcher.exe') -Destination (Join-Path $resolvedStaging "versions\$version\launcher")
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.AuthenticodeVerifier.exe') -Destination $resolvedStaging
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.exe') -Destination (Join-Path $resolvedStaging "versions\$version")
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.Core.dll') -Destination (Join-Path $resolvedStaging "versions\$version")
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'System.Data.SQLite.dll') -Destination (Join-Path $resolvedStaging "versions\$version")
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'x86\SQLite.Interop.dll') -Destination (Join-Path $resolvedStaging "versions\$version\x86")
Set-Content -LiteralPath (Join-Path $resolvedStaging 'versions\current.txt') -Value $version -Encoding ASCII
New-Item -ItemType Directory -Path $installerOutputRoot -Force | Out-Null

$arguments = @(
    "/DBridgeVersion=$version",
    "/DPrototypeRoot=$prototypeRoot",
    "/DStagingRoot=$resolvedStaging",
    "/DInstallerOutputRoot=$installerOutputRoot"
)
if ($Mode -eq 'Offline') {
    if (-not (Test-Path -LiteralPath $OfflineRuntimePath)) {
        throw 'bridge_offline_runtime_missing'
    }
    $runtime = Get-Item -LiteralPath $OfflineRuntimePath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $runtime.FullName).Hash
    $signature = Get-AuthenticodeSignature -LiteralPath $runtime.FullName
    if ((-not [string]::Equals($actualHash, $expectedOfflineHash, [StringComparison]::OrdinalIgnoreCase)) -or
        ($signature.Status -ne 'Valid') -or
        ($signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation')) {
        throw 'bridge_offline_runtime_verification_failed'
    }
    $arguments += '/DOfflineRuntime'
    $arguments += "/DOfflineRuntimePath=$($runtime.FullName)"
}
$arguments += (Join-Path $prototypeRoot 'installer\LiangjianBridge.iss')

& $innoCompiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw "bridge_installer_build_failed: $LASTEXITCODE"
}

Get-ChildItem -LiteralPath $installerOutputRoot -Filter "LiangjianBridge-V4-$version-$($Mode.ToLowerInvariant())-setup.exe" | ForEach-Object {
    [pscustomobject]@{
        Path = $_.FullName
        Size = $_.Length
        SHA256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    }
}
