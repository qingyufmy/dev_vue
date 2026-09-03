param(
    [string]$InstalledRoot = 'C:\Program Files\AURUM\LiangjianBridge',
    [string]$Net48RuntimePath = ''
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $prototypeRoot '..\..\..'))
$testArtifactsRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'bridge\.test-artifacts'))
$rehearsalRoot = Join-Path $testArtifactsRoot 'v3-v4-two-hop'
$artifactsRoot = Join-Path $prototypeRoot 'artifacts'
$installed = [IO.Path]::GetFullPath($InstalledRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Assert-True([bool]$Condition, [string]$Code) {
    if (-not $Condition) { throw $Code }
}

function Assert-Equal([string]$Actual, [string]$Expected, [string]$Code) {
    if (-not [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
        throw "$Code`: expected=$Expected actual=$Actual"
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
    [IO.File]::WriteAllText($Path, $Value, $utf8NoBom)
}

function Write-LegacyPointer([string]$Root, [string]$Active, [string]$Previous, [string]$Status) {
    $payload = [ordered]@{
        active_version = $Active
        last_known_good_version = $Previous
        status = $Status
        expected_terminal_instance_ids = @()
        updated_at_utc_msc = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    } | ConvertTo-Json -Compress
    Write-Utf8NoBom (Join-Path $Root 'current.json') $payload
}

function Read-LegacyPointer([string]$Root) {
    Get-Content -LiteralPath (Join-Path $Root 'current.json') -Raw | ConvertFrom-Json
}

function Invoke-Launcher([string]$Path) {
    $process = Start-Process -FilePath $Path -WorkingDirectory (Split-Path -Parent $Path) `
        -Wait -PassThru
    Assert-Equal ([string]$process.ExitCode) '0' 'bridge_rehearsal_launcher_failed'
}

function Wait-File([string]$Path, [int]$TimeoutMilliseconds = 10000) {
    $deadline = [Environment]::TickCount64 + $TimeoutMilliseconds
    while (-not (Test-Path -LiteralPath $Path)) {
        if ([Environment]::TickCount64 -ge $deadline) {
            throw "bridge_rehearsal_marker_timeout: $Path"
        }
        Start-Sleep -Milliseconds 50
    }
}

$installedLauncherPresent = Test-Path -LiteralPath (Join-Path $installed 'AURUMBridge.Launcher.exe')
$installedBridgePresent = Test-Path -LiteralPath (Join-Path $installed 'versions\3.0.4\AURUMBridge.exe')
$installedVersionLauncherPresent = Test-Path -LiteralPath `
    (Join-Path $installed 'versions\3.0.4\launcher\AURUMBridge.Launcher.exe')
if (-not $installedLauncherPresent -or -not $installedBridgePresent `
    -or -not $installedVersionLauncherPresent) {
    throw 'bridge_rehearsal_installed_v3_missing'
}

$resolvedTestArtifacts = $testArtifactsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)
$expectedTestArtifacts = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'bridge\.test-artifacts')).TrimEnd([IO.Path]::DirectorySeparatorChar)
Assert-True ([string]::Equals($resolvedTestArtifacts, $expectedTestArtifacts,
    [StringComparison]::OrdinalIgnoreCase)) 'bridge_rehearsal_root_invalid'
if (Test-Path -LiteralPath $rehearsalRoot) {
    $resolvedRehearsal = [IO.Path]::GetFullPath($rehearsalRoot)
    Assert-True ($resolvedRehearsal.StartsWith($resolvedTestArtifacts + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) 'bridge_rehearsal_cleanup_path_invalid'
    Remove-Item -LiteralPath $resolvedRehearsal -Recurse -Force
}
New-Item -ItemType Directory -Path $rehearsalRoot -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($Net48RuntimePath)) {
    $prerequisites = Join-Path $testArtifactsRoot 'prerequisites'
    New-Item -ItemType Directory -Path $prerequisites -Force | Out-Null
    $Net48RuntimePath = Join-Path $prerequisites 'ndp48-web.exe'
    if (-not (Test-Path -LiteralPath $Net48RuntimePath)) {
        Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?LinkId=2085155' `
            -OutFile $Net48RuntimePath
    }
}
$runtime = [IO.Path]::GetFullPath($Net48RuntimePath)
Assert-True (Test-Path -LiteralPath $runtime) 'bridge_rehearsal_net48_runtime_missing'
Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath $runtime).Hash `
    '0BBA3094588C4BFEC301939985222A20B340BF03431563DEC8B2B4478B06FFFA' `
    'bridge_rehearsal_net48_runtime_hash_invalid'

$sourceHashes = [ordered]@{}
foreach ($relative in @(
    'AURUMBridge.Launcher.exe',
    'versions\3.0.4\AURUMBridge.exe',
    'versions\3.0.4\launcher\AURUMBridge.Launcher.exe'
)) {
    $sourceHashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $installed $relative)).Hash
}

& (Join-Path $prototypeRoot 'build.ps1') -Platform x86
$previousVersionOverride = $env:AURUM_WINDOWS_PRODUCT_VERSION_OVERRIDE
try {
    $env:AURUM_WINDOWS_PRODUCT_VERSION_OVERRIDE = '3.0.5'
    & cargo build --release -p liangjian-bridge-launcher `
        --manifest-path (Join-Path $repositoryRoot 'bridge\native\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'bridge_rehearsal_transition_launcher_build_failed' }
}
finally {
    if ($null -eq $previousVersionOverride) {
        Remove-Item Env:AURUM_WINDOWS_PRODUCT_VERSION_OVERRIDE -ErrorAction SilentlyContinue
    }
    else { $env:AURUM_WINDOWS_PRODUCT_VERSION_OVERRIDE = $previousVersionOverride }
}
$transitionV3Launcher = Join-Path $repositoryRoot `
    'bridge\native\target\x86_64-pc-windows-msvc\release\liangjian-bridge-launcher.exe'
Assert-Equal (Get-Item -LiteralPath $transitionV3Launcher).VersionInfo.FileVersion '3.0.5' `
    'bridge_rehearsal_transition_launcher_version_invalid'

$installRoot = Join-Path $rehearsalRoot 'install'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Get-ChildItem -LiteralPath $installed -File -Force | Copy-Item -Destination $installRoot -Force
Copy-Item -LiteralPath (Join-Path $installed 'versions') -Destination $installRoot -Recurse -Force
$updateFixture = Join-Path $artifactsRoot 'LiangjianBridge.UpdateFixture.exe'
$coreLibrary = Join-Path $artifactsRoot 'LiangjianBridge.Core.dll'
$clonedV3 = Join-Path $installRoot 'versions\3.0.4'
Copy-Item -LiteralPath $updateFixture -Destination (Join-Path $clonedV3 'AURUMBridge.exe') -Force
Copy-Item -LiteralPath $updateFixture -Destination (Join-Path $clonedV3 'LiangjianBridge.exe') -Force
Copy-Item -LiteralPath $coreLibrary -Destination $clonedV3 -Force

$transitionSource = Join-Path $rehearsalRoot 'transition-source'
$transitionLauncherDirectory = Join-Path $transitionSource 'launcher'
New-Item -ItemType Directory -Path $transitionLauncherDirectory -Force | Out-Null
Copy-Item -LiteralPath $updateFixture -Destination (Join-Path $transitionSource 'AURUMBridge.exe') -Force
Copy-Item -LiteralPath $updateFixture -Destination (Join-Path $transitionSource 'LiangjianBridge.exe') -Force
Copy-Item -LiteralPath $coreLibrary -Destination $transitionSource -Force
Copy-Item -LiteralPath $transitionV3Launcher `
    -Destination (Join-Path $transitionLauncherDirectory 'AURUMBridge.Launcher.exe') -Force
$transitionPackageSource = Join-Path $rehearsalRoot 'transition-package-source'
& (Join-Path $prototypeRoot 'stage-v3-v4-upgrade.ps1') -Phase Transition `
    -Destination $transitionPackageSource -V3VersionDirectory $transitionSource -SkipBuild | Out-Null
Assert-True (Test-Path -LiteralPath (Join-Path $transitionPackageSource `
    'launcher\AURUMBridge.TransitionLauncher.exe')) 'bridge_rehearsal_native_sibling_missing'
Assert-Equal (Get-Item -LiteralPath (Join-Path $transitionPackageSource `
    'launcher\AURUMBridge.Launcher.exe')).VersionInfo.FileVersion '3.0.5' `
    'bridge_rehearsal_v3_candidate_not_preserved'

$v4Source = Join-Path $rehearsalRoot 'v4-source'
& (Join-Path $prototypeRoot 'stage-v3-v4-upgrade.ps1') -Phase V4 `
    -Destination $v4Source -Net48RuntimePath $runtime -SkipBuild | Out-Null
Copy-Item -LiteralPath $updateFixture -Destination (Join-Path $v4Source 'AURUMBridge.exe') -Force
Copy-Item -LiteralPath $updateFixture -Destination (Join-Path $v4Source 'LiangjianBridge.exe') -Force
Write-Utf8NoBom (Join-Path $v4Source 'handoff.prepare') '1'
$badV4Source = Join-Path $rehearsalRoot 'v4-bad-source'
Copy-Item -LiteralPath $v4Source -Destination $badV4Source -Recurse -Force
Write-Utf8NoBom (Join-Path $badV4Source 'health.fail') '1'

$signedFixture = Join-Path $artifactsRoot 'LiangjianBridge.SignedStageFixture.exe'
& $signedFixture $installRoot '3.0.4' '3.0.5' $transitionPackageSource `
    '4.0.0.0' $v4Source '4.0.0.1' $badV4Source
if ($LASTEXITCODE -ne 0) { throw 'bridge_rehearsal_signed_stage_failed' }

Write-LegacyPointer $installRoot '3.0.5' '3.0.4' 'pending'
$versionedTransition = Join-Path $installRoot 'versions\3.0.5\launcher\AURUMBridge.Launcher.exe'
Invoke-Launcher $versionedTransition
Wait-File (Join-Path $installRoot 'versions\3.0.5\started.marker')
$afterTransition = Read-LegacyPointer $installRoot
Assert-Equal $afterTransition.active_version '3.0.5' 'bridge_rehearsal_transition_active_invalid'
Assert-Equal $afterTransition.last_known_good_version '3.0.5' 'bridge_rehearsal_transition_lkg_invalid'
Assert-Equal $afterTransition.status 'healthy' 'bridge_rehearsal_transition_not_healthy'
Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $installRoot `
    'AURUMBridge.Launcher.exe')).Hash (Get-FileHash -Algorithm SHA256 -LiteralPath `
    (Join-Path $installRoot 'versions\3.0.5\launcher\AURUMBridge.TransitionLauncher.exe')).Hash `
    'bridge_rehearsal_native_launcher_not_promoted'

Write-LegacyPointer $installRoot '4.0.0.0' '3.0.5' 'pending'
$stableLauncher = Join-Path $installRoot 'AURUMBridge.Launcher.exe'
Invoke-Launcher $stableLauncher
Wait-File (Join-Path $installRoot 'versions\4.0.0.0\started.marker')
$afterV4 = Read-LegacyPointer $installRoot
Assert-Equal $afterV4.active_version '4.0.0.0' 'bridge_rehearsal_v4_active_invalid'
Assert-Equal $afterV4.last_known_good_version '4.0.0.0' 'bridge_rehearsal_v4_lkg_invalid'
Assert-Equal $afterV4.status 'healthy' 'bridge_rehearsal_v4_not_healthy'
Assert-Equal (Get-Content -LiteralPath (Join-Path $installRoot 'versions\current.txt') -Raw).Trim() `
    '4.0.0.0' 'bridge_rehearsal_v4_current_invalid'

Remove-Item -LiteralPath (Join-Path $installRoot 'versions\4.0.0.0\started.marker') -Force
Write-LegacyPointer $installRoot '4.0.0.1' '4.0.0.0' 'pending'
Invoke-Launcher $stableLauncher
Wait-File (Join-Path $installRoot 'versions\4.0.0.0\started.marker')
$afterRollback = Read-LegacyPointer $installRoot
Assert-Equal $afterRollback.active_version '4.0.0.0' 'bridge_rehearsal_rollback_active_invalid'
Assert-Equal $afterRollback.last_known_good_version '4.0.0.0' 'bridge_rehearsal_rollback_lkg_invalid'
Assert-Equal $afterRollback.status 'rolled_back' 'bridge_rehearsal_rollback_status_invalid'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot `
    'versions\4.0.0.1\started.marker'))) 'bridge_rehearsal_failed_v4_started'
Assert-Equal (Get-Content -LiteralPath (Join-Path $installRoot 'versions\current.txt') -Raw).Trim() `
    '4.0.0.0' 'bridge_rehearsal_rollback_v4_current_invalid'
Assert-Equal (Get-Content -LiteralPath (Join-Path $installRoot 'versions\previous.txt') -Raw).Trim() `
    '4.0.0.0' 'bridge_rehearsal_rollback_v4_previous_invalid'

Remove-Item -LiteralPath (Join-Path $installRoot 'versions\4.0.0.0\started.marker') -Force
Invoke-Launcher $stableLauncher
Wait-File (Join-Path $installRoot 'versions\4.0.0.0\started.marker')
$afterRecovery = Read-LegacyPointer $installRoot
Assert-Equal $afterRecovery.status 'healthy' 'bridge_rehearsal_recovery_not_healthy'

foreach ($relative in $sourceHashes.Keys) {
    Assert-Equal (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $installed $relative)).Hash `
        $sourceHashes[$relative] 'bridge_rehearsal_modified_installed_source'
}

$result = [ordered]@{
    mode = 'local-signed-two-hop-rehearsal'
    source_install = $installed
    rehearsal_install = $installRoot
    source_untouched = $true
    transition_version = '3.0.5'
    target_version = '4.0.0.0'
    failed_version = '4.0.0.1'
    transition_promoted_native_launcher = $true
    target_healthy = $true
    rollback_verified = $true
    recovery_healthy = $true
    production_untouched = $true
}
$resultPath = Join-Path $rehearsalRoot 'result.json'
Write-Utf8NoBom $resultPath ($result | ConvertTo-Json)
$result | Format-List
Write-Host "PASS bridge_v3_v4_signed_two_hop_rehearsal: $resultPath"
