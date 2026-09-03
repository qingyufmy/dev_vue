param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Transition', 'V4')]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [string]$V3VersionDirectory = '',
    [string]$Net48RuntimePath = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = Join-Path $prototypeRoot 'artifacts'
$destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ([string]::Equals($destinationRoot, [IO.Path]::GetPathRoot($destinationRoot),
    [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destinationRoot)) {
    throw 'bridge_upgrade_stage_destination_invalid'
}

if (-not $SkipBuild) {
    & (Join-Path $prototypeRoot 'build.ps1') -Platform x86
}
$nativeLauncher = Join-Path $artifactsRoot 'AURUMBridge.Launcher.exe'
$managedLauncher = Join-Path $artifactsRoot 'LiangjianBridge.Launcher.exe'
$signatureVerifier = Join-Path $artifactsRoot 'LiangjianBridge.AuthenticodeVerifier.exe'
foreach ($requiredArtifact in @($nativeLauncher, $managedLauncher, $signatureVerifier)) {
    if (-not (Test-Path -LiteralPath $requiredArtifact)) {
        throw "bridge_upgrade_stage_artifact_missing: $requiredArtifact"
    }
}

if ($Phase -eq 'Transition') {
        if ([string]::IsNullOrWhiteSpace($V3VersionDirectory)) {
            throw 'bridge_transition_v3_source_required'
        }
        $source = [IO.Path]::GetFullPath($V3VersionDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath (Join-Path $source 'AURUMBridge.exe'))) {
            throw 'bridge_transition_v3_entry_missing'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $source 'launcher\AURUMBridge.Launcher.exe'))) {
            throw 'bridge_transition_v3_launcher_missing'
        }
        if ($destinationRoot.StartsWith($source + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
            throw 'bridge_transition_destination_inside_source'
        }
        New-Item -ItemType Directory -Path $destinationRoot | Out-Null
        Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $destinationRoot -Recurse -Force
        $launcherDirectory = Join-Path $destinationRoot 'launcher'
        New-Item -ItemType Directory -Path $launcherDirectory -Force | Out-Null
        Copy-Item -LiteralPath $nativeLauncher `
            -Destination (Join-Path $launcherDirectory 'AURUMBridge.TransitionLauncher.exe') -Force
}
else {
        if (-not (Test-Path -LiteralPath $Net48RuntimePath)) {
            throw 'bridge_transition_net48_runtime_required'
        }
        $runtime = Get-Item -LiteralPath $Net48RuntimePath
        $runtimeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $runtime.FullName).Hash
        $allowedRuntimeHashes = @(
            '0BBA3094588C4BFEC301939985222A20B340BF03431563DEC8B2B4478B06FFFA',
            '0A3A390C47E639D0F7FC65B21195FEE6B7F65B066F80F70C60FAB191D14B7E40'
        )
        if ($runtimeHash -notin $allowedRuntimeHashes) {
            throw 'bridge_transition_net48_runtime_hash_invalid'
        }
        $runtimeFileName = if ($runtimeHash -eq $allowedRuntimeHashes[0]) {
            'ndp48-web.exe'
        } else {
            'NDP48-x86-x64-AllOS-ENU.exe'
        }
        $verify = Start-Process -FilePath $signatureVerifier -ArgumentList ('"' + $runtime.FullName + '"') `
            -WorkingDirectory $artifactsRoot -Wait -PassThru
        if ($verify.ExitCode -ne 0) { throw 'bridge_transition_net48_runtime_signature_invalid' }

        New-Item -ItemType Directory -Path $destinationRoot | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $destinationRoot 'launcher') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $destinationRoot 'prerequisites') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $destinationRoot 'x86') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.exe') -Destination $destinationRoot
        Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.exe') `
            -Destination (Join-Path $destinationRoot 'AURUMBridge.exe')
        Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.Core.dll') -Destination $destinationRoot
        Copy-Item -LiteralPath (Join-Path $artifactsRoot 'System.Data.SQLite.dll') -Destination $destinationRoot
        Copy-Item -LiteralPath (Join-Path $artifactsRoot 'x86\SQLite.Interop.dll') `
            -Destination (Join-Path $destinationRoot 'x86')
        Copy-Item -LiteralPath $nativeLauncher -Destination (Join-Path $destinationRoot 'launcher\AURUMBridge.Launcher.exe')
        Copy-Item -LiteralPath $managedLauncher -Destination (Join-Path $destinationRoot 'launcher\LiangjianBridge.Launcher.exe')
        Copy-Item -LiteralPath $signatureVerifier -Destination (Join-Path $destinationRoot 'prerequisites')
        Copy-Item -LiteralPath $runtime.FullName -Destination (Join-Path $destinationRoot ('prerequisites\' + $runtimeFileName))
}
[pscustomobject]@{
    Phase = $Phase
    Destination = $destinationRoot
    StableLauncherVersion = (Get-Item -LiteralPath $nativeLauncher).VersionInfo.FileVersion
    SourcePreserved = $true
}
