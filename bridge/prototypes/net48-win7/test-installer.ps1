$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = Join-Path $prototypeRoot 'artifacts'
$installRoot = Join-Path $artifactsRoot 'installed-smoke'
$setup = Join-Path $artifactsRoot 'installer\LiangjianBridge-V4-4.0.0.0-online-setup.exe'
$resolvedArtifacts = [IO.Path]::GetFullPath($artifactsRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedInstall = [IO.Path]::GetFullPath($installRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)

if (-not $resolvedInstall.StartsWith($resolvedArtifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "bridge_installer_smoke_root_invalid: $resolvedInstall"
}
if (-not (Test-Path -LiteralPath $setup)) {
    & (Join-Path $prototypeRoot 'build-installer.ps1') -Mode Online
}

function Wait-ProcessExit([Diagnostics.Process]$Process, [int]$TimeoutMilliseconds, [string]$ErrorCode) {
    if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
        Stop-Process -Id $Process.Id -Force
        throw $ErrorCode
    }
    if ($Process.ExitCode -ne 0) {
        throw "$ErrorCode`:$($Process.ExitCode)"
    }
}

function Remove-SmokeInstall {
    $uninstaller = Join-Path $resolvedInstall 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -PassThru
        Wait-ProcessExit $uninstallProcess 15000 'bridge_installer_smoke_uninstall_failed'
    }
}

Remove-SmokeInstall
$knownProcessIds = @(Get-Process -Name LiangjianBridge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
try {
    $installProcess = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',"/DIR=$resolvedInstall" -PassThru
    Wait-ProcessExit $installProcess 15000 'bridge_installer_smoke_install_failed'

    $launcher = Join-Path $resolvedInstall 'AURUMBridge.Launcher.exe'
    if (-not (Test-Path -LiteralPath $launcher)) {
        throw 'bridge_installer_smoke_launcher_missing'
    }
    $launcherProcess = Start-Process -FilePath $launcher -PassThru
    Wait-ProcessExit $launcherProcess 5000 'bridge_installer_smoke_launcher_failed'
    Start-Sleep -Milliseconds 750

    $applications = @(Get-Process -Name LiangjianBridge -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $knownProcessIds })
    if ($applications.Count -ne 1) {
        throw "bridge_installer_smoke_app_start_failed:$($applications.Count)"
    }
    Stop-Process -Id $applications[0].Id -Force
    if (-not $applications[0].WaitForExit(5000)) { throw 'bridge_installer_smoke_app_stop_timeout' }
    Write-Host 'PASS installer_launches_versioned_app'
}
finally {
    Get-Process -Name LiangjianBridge -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -notin $knownProcessIds } |
        Stop-Process -Force
    Remove-SmokeInstall
}

if (Test-Path -LiteralPath (Join-Path $resolvedInstall 'AURUMBridge.Launcher.exe')) {
    throw 'bridge_installer_smoke_uninstall_incomplete'
}
Write-Host 'PASS installer_install_launch_uninstall'
