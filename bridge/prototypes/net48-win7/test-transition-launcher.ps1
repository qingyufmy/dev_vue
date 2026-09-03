$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = Join-Path $prototypeRoot 'artifacts'
$launcher = Join-Path $artifactsRoot 'AURUMBridge.Launcher.exe'
$fixture = Join-Path $artifactsRoot 'LiangjianBridge.UpdateFixture.exe'

& (Join-Path $prototypeRoot 'build.ps1') -Platform x86
if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $fixture)) {
    throw 'bridge_transition_test_artifacts_missing'
}
$version = (Get-Item -LiteralPath $launcher).VersionInfo.FileVersion
if ($version -ne '4.0.0.0') { throw "bridge_transition_launcher_version_invalid: $version" }

$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$testRoot = Join-Path $temporaryBase ('liangjian-transition-' + [Guid]::NewGuid().ToString('N'))
if (-not ([IO.Path]::GetFullPath($testRoot)).StartsWith(
    $temporaryBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'bridge_transition_test_root_invalid'
}

function Invoke-Launcher([string]$root, [string[]]$arguments = @()) {
    $start = @{
        FilePath = Join-Path $root 'AURUMBridge.Launcher.exe'
        WorkingDirectory = $root
        Wait = $true
        PassThru = $true
    }
    if ($arguments.Count -gt 0) { $start.ArgumentList = $arguments }
    $process = Start-Process @start
    if ($process.ExitCode -ne 0) { throw "bridge_transition_launcher_failed: $($process.ExitCode)" }
}

try {
    $legacyRoot = Join-Path $testRoot 'legacy'
    $legacyLauncherDirectory = Join-Path $legacyRoot 'versions\3.0.4\launcher'
    New-Item -ItemType Directory -Path $legacyLauncherDirectory -Force | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $legacyRoot
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $legacyLauncherDirectory 'AURUMBridge.Launcher.exe')
    Set-Content -LiteralPath (Join-Path $legacyRoot 'current.json') -Encoding ASCII -Value `
        '{"active_version":"3.0.5","last_known_good_version":"3.0.4","status":"healthy"}'
    Invoke-Launcher $legacyRoot
    if (-not (Test-Path -LiteralPath (Join-Path $legacyLauncherDirectory 'started.marker'))) {
        throw 'bridge_transition_legacy_launcher_not_delegated'
    }
    Invoke-Launcher $legacyRoot @('--autostart')
    if ((Get-Content -LiteralPath (Join-Path $legacyLauncherDirectory 'arguments.marker') -Raw).Trim() -ne '--autostart') {
        throw 'bridge_transition_legacy_autostart_not_forwarded'
    }
    Invoke-Launcher $legacyRoot @('--uninstall')
    if ((Get-Content -LiteralPath (Join-Path $legacyLauncherDirectory 'arguments.marker') -Raw).Trim() -ne '--uninstall') {
        throw 'bridge_transition_legacy_uninstall_not_forwarded'
    }

    $freshRoot = Join-Path $testRoot 'fresh-v4'
    $managedDirectory = Join-Path $freshRoot 'versions\4.0.0.0\launcher'
    New-Item -ItemType Directory -Path $managedDirectory -Force | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $freshRoot
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $managedDirectory 'LiangjianBridge.Launcher.exe')
    Set-Content -LiteralPath (Join-Path $freshRoot 'versions\current.txt') -Encoding ASCII -Value '4.0.0.0'
    Invoke-Launcher $freshRoot @('--autostart')
    if ((Get-Content -LiteralPath (Join-Path $managedDirectory 'arguments.marker') -Raw).Trim() -ne '--autostart') {
        throw 'bridge_transition_managed_arguments_not_forwarded'
    }
    $observedInstallRoot = (Get-Content -LiteralPath (Join-Path $managedDirectory 'install-root.marker') -Raw).Trim()
    if (-not [string]::Equals($observedInstallRoot, [IO.Path]::GetFullPath($freshRoot),
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'bridge_transition_install_root_not_forwarded'
    }

    $migratedRoot = Join-Path $testRoot 'migrated-v4'
    $migratedManaged = Join-Path $migratedRoot 'versions\4.0.0.0\launcher'
    New-Item -ItemType Directory -Path $migratedManaged -Force | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $migratedRoot
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $migratedManaged 'LiangjianBridge.Launcher.exe')
    Set-Content -LiteralPath (Join-Path $migratedRoot 'versions\current.txt') -Encoding ASCII -Value '4.0.0.0'
    Set-Content -LiteralPath (Join-Path $migratedRoot 'current.json') -Encoding ASCII -Value `
        '{"active_version":"4.0.0.0","last_known_good_version":"3.0.5","status":"healthy"}'
    Invoke-Launcher $migratedRoot
    if (-not (Test-Path -LiteralPath (Join-Path $migratedManaged 'started.marker'))) {
        throw 'bridge_transition_migrated_v4_not_delegated'
    }

    $transitionSource = Join-Path $testRoot 'transition-source'
    $transitionDestination = Join-Path $testRoot 'transition-output'
    New-Item -ItemType Directory -Path (Join-Path $transitionSource 'launcher') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $transitionSource 'AURUMBridge.exe') -Encoding ASCII -Value 'v3-core'
    Set-Content -LiteralPath (Join-Path $transitionSource 'launcher\AURUMBridge.Launcher.exe') `
        -Encoding ASCII -Value 'v3-launcher'
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath `
        (Join-Path $transitionSource 'launcher\AURUMBridge.Launcher.exe')).Hash
    & (Join-Path $prototypeRoot 'stage-v3-v4-upgrade.ps1') -Phase Transition `
        -Destination $transitionDestination -V3VersionDirectory $transitionSource | Out-Null
    if ((Get-Item -LiteralPath (Join-Path $transitionDestination 'launcher\AURUMBridge.TransitionLauncher.exe')).VersionInfo.FileVersion `
        -ne '4.0.0.0') { throw 'bridge_transition_stage_launcher_invalid' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath `
        (Join-Path $transitionDestination 'launcher\AURUMBridge.Launcher.exe')).Hash -ne $sourceHash) {
        throw 'bridge_transition_stage_replaced_v3_launcher'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath `
        (Join-Path $transitionSource 'launcher\AURUMBridge.Launcher.exe')).Hash -ne $sourceHash) {
        throw 'bridge_transition_stage_modified_source'
    }
    $invalidDestination = Join-Path $testRoot 'invalid-transition-output'
    $invalidError = $null
    try {
        & (Join-Path $prototypeRoot 'stage-v3-v4-upgrade.ps1') -Phase Transition `
            -Destination $invalidDestination -V3VersionDirectory (Join-Path $testRoot 'missing-source') | Out-Null
    }
    catch {
        $invalidError = $_.Exception.Message
    }
    if ($invalidError -ne 'bridge_transition_v3_entry_missing' -or
        (Test-Path -LiteralPath $invalidDestination)) {
        throw 'bridge_transition_invalid_source_left_destination'
    }
    $nestedDestination = Join-Path $transitionSource 'nested-output'
    $nestedError = $null
    try {
        & (Join-Path $prototypeRoot 'stage-v3-v4-upgrade.ps1') -Phase Transition `
            -Destination $nestedDestination -V3VersionDirectory $transitionSource | Out-Null
    }
    catch {
        $nestedError = $_.Exception.Message
    }
    if ($nestedError -ne 'bridge_transition_destination_inside_source' -or
        (Test-Path -LiteralPath $nestedDestination)) {
        throw 'bridge_transition_nested_destination_created'
    }
    $invalidRuntime = Join-Path $testRoot 'invalid-runtime.exe'
    $invalidV4Destination = Join-Path $testRoot 'invalid-v4-output'
    Set-Content -LiteralPath $invalidRuntime -Encoding ASCII -Value 'not-a-runtime'
    $invalidRuntimeError = $null
    try {
        & (Join-Path $prototypeRoot 'stage-v3-v4-upgrade.ps1') -Phase V4 `
            -Destination $invalidV4Destination -Net48RuntimePath $invalidRuntime | Out-Null
    }
    catch {
        $invalidRuntimeError = $_.Exception.Message
    }
    if ($invalidRuntimeError -ne 'bridge_transition_net48_runtime_hash_invalid' -or
        (Test-Path -LiteralPath $invalidV4Destination)) {
        throw 'bridge_transition_invalid_runtime_left_destination'
    }

    $handoffRoot = Join-Path $testRoot 'handoff'
    $handoffCurrent = Join-Path $handoffRoot 'versions\4.0.0.0'
    $handoffPrevious = Join-Path $handoffRoot 'versions\3.0.5'
    New-Item -ItemType Directory -Path $handoffCurrent,$handoffPrevious -Force | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $handoffRoot
    Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.exe') `
        -Destination (Join-Path $handoffCurrent 'AURUMBridge.exe')
    Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.exe') -Destination $handoffCurrent
    Copy-Item -LiteralPath (Join-Path $artifactsRoot 'LiangjianBridge.Core.dll') -Destination $handoffCurrent
    Copy-Item -LiteralPath $fixture -Destination (Join-Path $handoffPrevious 'AURUMBridge.exe')
    $handoffPointer = '{"active_version":"4.0.0.0","last_known_good_version":"3.0.5","status":"pending","expected_terminal_instance_ids":[],"updated_at_utc_msc":1800000000000}'
    Set-Content -LiteralPath (Join-Path $handoffRoot 'current.json') -Encoding ASCII -Value $handoffPointer
    $handoffHealth = Join-Path $handoffRoot 'health-handoff.json'
    $handoff = Start-Process -FilePath (Join-Path $handoffCurrent 'AURUMBridge.exe') `
        -ArgumentList '--health-check','--health-file',('"' + $handoffHealth + '"') `
        -WorkingDirectory $handoffCurrent -Wait -PassThru
    $handoffCurrentPointer = (Get-Content -LiteralPath `
        (Join-Path $handoffRoot 'versions\current.txt') -Raw).Trim()
    $handoffPreviousPointer = (Get-Content -LiteralPath `
        (Join-Path $handoffRoot 'versions\previous.txt') -Raw).Trim()
    $handoffLegacyPointer = (Get-Content -LiteralPath `
        (Join-Path $handoffRoot 'current.json') -Raw).Trim()
    $handoffAlias = Test-Path -LiteralPath (Join-Path $handoffPrevious 'LiangjianBridge.exe')
    if ($handoff.ExitCode -ne 0 -or
        -not (Test-Path -LiteralPath $handoffHealth) -or
        $handoffCurrentPointer -ne '4.0.0.0' -or
        $handoffPreviousPointer -ne '3.0.5' -or
        -not $handoffAlias -or
        $handoffLegacyPointer -ne $handoffPointer) {
        throw 'bridge_transition_v4_handoff_failed'
    }

    $installedLegacyLauncher = 'C:\Program Files\AURUM\LiangjianBridge\versions\3.0.4\launcher\AURUMBridge.Launcher.exe'
    $rollbackResult = 'not-run'
    if (Test-Path -LiteralPath $installedLegacyLauncher) {
        $rollbackRoot = Join-Path $testRoot 'rollback'
        $oldLauncherDirectory = Join-Path $rollbackRoot 'versions\3.0.4\launcher'
        $previousDirectory = Join-Path $rollbackRoot 'versions\3.0.5'
        $failedDirectory = Join-Path $rollbackRoot 'versions\4.0.0.0'
        New-Item -ItemType Directory -Path $oldLauncherDirectory,$previousDirectory,$failedDirectory -Force | Out-Null
        Copy-Item -LiteralPath $launcher -Destination $rollbackRoot
        Copy-Item -LiteralPath $installedLegacyLauncher -Destination $oldLauncherDirectory
        Copy-Item -LiteralPath $fixture -Destination (Join-Path $previousDirectory 'AURUMBridge.exe')
        Copy-Item -LiteralPath $fixture -Destination (Join-Path $failedDirectory 'AURUMBridge.exe')
        Copy-Item -LiteralPath $fixture -Destination (Join-Path $failedDirectory 'LiangjianBridge.exe')
        Set-Content -LiteralPath (Join-Path $failedDirectory 'ready.fail') -Encoding ASCII -Value 'expected'
        Set-Content -LiteralPath (Join-Path $rollbackRoot 'current.json') -Encoding ASCII -Value `
            '{"active_version":"4.0.0.0","last_known_good_version":"3.0.5","status":"pending","expected_terminal_instance_ids":[],"updated_at_utc_msc":1800000000000}'
        Set-Content -LiteralPath (Join-Path $rollbackRoot 'update-state.json') -Encoding ASCII -Value `
            '{"schema_version":1,"state":"verifying","target_version":"4.0.0.0","release_id":"release_test","priority":"normal","manual_activation_requested":false,"staged_at_utc_msc":1800000000000,"activation_started_at_utc_msc":1800000000000,"minimum_idle_seconds":30,"activation_deadline_utc_msc":null,"maintenance_lease_id":null,"maintenance_lease_expires_at_utc_msc":null,"next_retry_at_utc_msc":null,"last_error_code":null,"updated_at_utc_msc":1800000000000}'
        Invoke-Launcher $rollbackRoot
        $rolledBack = Get-Content -LiteralPath (Join-Path $rollbackRoot 'current.json') -Raw | ConvertFrom-Json
        $previousStarted = Test-Path -LiteralPath (Join-Path $previousDirectory 'started.marker')
        if ($rolledBack.active_version -ne '3.0.5' -or
            $rolledBack.status -ne 'rolled_back' -or -not $previousStarted) {
            throw 'bridge_transition_legacy_rollback_failed'
        }
        $rollbackResult = 'passed'
    }

    [pscustomobject]@{
        LauncherVersion = $version
        LegacyDelegation = 'passed'
        LegacyShellArguments = 'passed'
        FreshV4Delegation = 'passed'
        MigratedV4Delegation = 'passed'
        TransitionStaging = 'passed'
        V4PointerHandoff = 'passed'
        LegacyRollback = $rollbackResult
        StableEntry = 'AURUMBridge.Launcher.exe'
    }
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
