param(
    [ValidateSet('x86', 'x64')]
    [string]$Platform = 'x86'
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = Join-Path $prototypeRoot 'artifacts'
$rehearsalRoot = Join-Path $artifactsRoot 'update-rehearsal'
$resolvedArtifacts = [IO.Path]::GetFullPath($artifactsRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedRehearsal = [IO.Path]::GetFullPath($rehearsalRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)

if (-not $resolvedRehearsal.StartsWith($resolvedArtifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "bridge_update_rehearsal_root_invalid: $resolvedRehearsal"
}

& (Join-Path $prototypeRoot 'build.ps1') -Platform $Platform

if (Test-Path -LiteralPath $resolvedRehearsal) {
    Remove-Item -LiteralPath $resolvedRehearsal -Recurse -Force
}
$versionsRoot = Join-Path $resolvedRehearsal 'versions'
$oldRoot = Join-Path $versionsRoot '4.0.0.0'
$goodRoot = Join-Path $versionsRoot '4.0.1.0'
$badRoot = Join-Path $versionsRoot '4.0.2.0'
New-Item -ItemType Directory -Path $oldRoot, $goodRoot, $badRoot -Force | Out-Null

$fixture = Join-Path $artifactsRoot 'LiangjianBridge.UpdateFixture.exe'
foreach ($versionRoot in @($oldRoot, $goodRoot, $badRoot)) {
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $versionRoot 'LiangjianBridge.exe') -Force
}
Set-Content -LiteralPath (Join-Path $badRoot 'health.fail') -Value 'expected failure' -Encoding ASCII
Set-Content -LiteralPath (Join-Path $versionsRoot 'current.txt') -Value '4.0.0.0' -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.Launcher.exe') -Destination $resolvedRehearsal -Force

$dataRoot = Join-Path $resolvedRehearsal 'data\profiles'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$preserved = Join-Path $dataRoot 'preserved.marker'
Set-Content -LiteralPath $preserved -Value 'keep-me' -Encoding UTF8
$preservedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $preserved).Hash

function Invoke-LauncherActivation([string]$Version) {
    $launcher = Join-Path $resolvedRehearsal 'LiangjianBridge.Launcher.exe'
    $process = Start-Process -FilePath $launcher -ArgumentList '--activate', $Version -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(15000)) {
        Stop-Process -Id $process.Id -Force
        throw "bridge_update_launcher_timeout:$Version"
    }
    if ($process.ExitCode -ne 0) {
        throw "bridge_update_launcher_failed:$Version`:$($process.ExitCode)"
    }
}

function Wait-Marker([string]$Path) {
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    while (-not (Test-Path -LiteralPath $Path)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "bridge_update_start_marker_timeout:$Path"
        }
        Start-Sleep -Milliseconds 50
    }
}

Invoke-LauncherActivation '4.0.1.0'
Wait-Marker (Join-Path $goodRoot 'started.marker')
if ((Get-Content -LiteralPath (Join-Path $versionsRoot 'current.txt')).Trim() -ne '4.0.1.0') {
    throw 'bridge_update_good_version_not_active'
}
if (Test-Path -LiteralPath (Join-Path $versionsRoot 'activation-pending.txt')) {
    throw 'bridge_update_good_activation_not_completed'
}

$goodStartMarker = Join-Path $goodRoot 'started.marker'
if (Test-Path -LiteralPath $goodStartMarker) {
    Remove-Item -LiteralPath $goodStartMarker -Force
}
Invoke-LauncherActivation '4.0.2.0'
Wait-Marker $goodStartMarker
if ((Get-Content -LiteralPath (Join-Path $versionsRoot 'current.txt')).Trim() -ne '4.0.1.0') {
    throw 'bridge_update_failed_version_not_rolled_back'
}
if (Test-Path -LiteralPath (Join-Path $versionsRoot 'activation-pending.txt')) {
    throw 'bridge_update_failed_activation_pending_remained'
}
if (Test-Path -LiteralPath (Join-Path $badRoot 'started.marker')) {
    throw 'bridge_update_unhealthy_version_started'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $preserved).Hash -ne $preservedHash) {
    throw 'bridge_update_data_changed'
}

Write-Host "PASS update_activation_and_health_rollback ($Platform)"
Write-Host 'PASS update_preserves_data_root'
