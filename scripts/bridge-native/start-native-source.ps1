[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Stop-WithStableError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Code,
        [string]$Detail
    )
    if ([string]::IsNullOrWhiteSpace($Detail)) {
        throw $Code
    }
    throw "${Code}: $Detail"
}

function Resolve-ExistingDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$ErrorCode
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        Stop-WithStableError $ErrorCode $Path
    }
    try {
        return [IO.Path]::GetFullPath($Path)
    }
    catch {
        Stop-WithStableError $ErrorCode $Path
    }
}

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$ErrorCode
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Stop-WithStableError $ErrorCode $Path
    }
    try {
        return [IO.Path]::GetFullPath($Path)
    }
    catch {
        Stop-WithStableError $ErrorCode $Path
    }
}

function Assert-PathWithinRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Root,
        [Parameter(Mandatory = $true)]
        [string]$ErrorCode
    )
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-WithStableError $ErrorCode $resolvedPath
    }
    return $resolvedPath
}

function Assert-NotReparsePoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$ErrorCode
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    }
    catch {
        Stop-WithStableError $ErrorCode $Path
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-WithStableError $ErrorCode $Path
    }
}

function Get-RunningBridgeProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ExpectedPaths
    )
    try {
        $resolvedExpected = @($ExpectedPaths | ForEach-Object {
                [IO.Path]::GetFullPath($_)
            })
        return @(Get-CimInstance Win32_Process -ErrorAction Stop |
                Where-Object {
                    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
                    $resolvedExpected -contains ([IO.Path]::GetFullPath($_.ExecutablePath))
                })
    }
    catch {
        Stop-WithStableError 'native_source_process_check_failed'
    }
}

function Assert-NoDebugBridgeProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$UiPath,
        [Parameter(Mandatory = $true)]
        [string]$CorePath
    )
    $running = @(Get-RunningBridgeProcess -ExpectedPaths @($UiPath, $CorePath))
    if ($running.Count -gt 0) {
        $names = ($running | ForEach-Object { $_.Name }) -join ','
        Stop-WithStableError 'native_source_process_already_running' $names
    }
}

$repoRoot = Resolve-ExistingDirectory `
    -Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) `
    -ErrorCode 'native_source_repo_invalid'
$nativeRoot = Resolve-ExistingDirectory `
    -Path (Join-Path $repoRoot 'bridge\native') `
    -ErrorCode 'native_source_native_root_invalid'
$manifest = Resolve-ExistingFile `
    -Path (Join-Path $nativeRoot 'Cargo.toml') `
    -ErrorCode 'native_source_manifest_missing'
$debugRoot = Assert-PathWithinRoot `
    -Path (Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\debug') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_directory_invalid'
$debugUi = Assert-PathWithinRoot `
    -Path (Join-Path $debugRoot 'liangjian-bridge-ui.exe') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
$debugCore = Assert-PathWithinRoot `
    -Path (Join-Path $debugRoot 'liangjian-bridge-core.exe') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
Assert-NotReparsePoint -Path $debugRoot -ErrorCode 'native_source_debug_path_invalid'

# Check before Cargo or any replacement, so an existing debug UI/Core can never be mixed with
# newly built files.  The script deliberately does not stop either process.
Assert-NoDebugBridgeProcess -UiPath $debugUi -CorePath $debugCore

$developmentEndpoints = Resolve-ExistingFile `
    -Path (Join-Path $nativeRoot 'config\development\server-endpoints.json') `
    -ErrorCode 'native_source_endpoint_config_missing'
try {
    $endpointConfig = Get-Content -LiteralPath $developmentEndpoints -Raw -Encoding UTF8 |
        ConvertFrom-Json
}
catch {
    Stop-WithStableError 'native_source_endpoint_config_invalid'
}
if ($endpointConfig.schema_version -ne 1 -or
    $endpointConfig.server_url -ne 'http://127.0.0.1:3000') {
    Stop-WithStableError 'native_source_endpoint_must_be_loopback'
}

$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargo = if ($null -ne $cargoCommand) {
    $cargoCommand.Source
}
else {
    Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
Resolve-ExistingFile -Path $cargo -ErrorCode 'native_source_cargo_not_installed' | Out-Null

if (-not $SkipBuild) {
    Push-Location $nativeRoot
    try {
        & $cargo build --locked --manifest-path $manifest -p liangjian-bridge-core -p liangjian-bridge-ui
        if ($LASTEXITCODE -ne 0) {
            Stop-WithStableError 'native_source_build_failed' $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}

Resolve-ExistingFile -Path $debugUi -ErrorCode 'native_source_debug_ui_missing' | Out-Null
Resolve-ExistingFile -Path $debugCore -ErrorCode 'native_source_debug_core_missing' | Out-Null

$workerSource = Resolve-ExistingFile `
    -Path (Join-Path $nativeRoot 'workers\mt5\worker.py') `
    -ErrorCode 'native_source_worker_source_missing'
$tradeSource = Resolve-ExistingFile `
    -Path (Join-Path $nativeRoot 'workers\mt5\trade.py') `
    -ErrorCode 'native_source_trade_source_missing'
$completionSource = Resolve-ExistingFile `
    -Path (Join-Path $nativeRoot 'workers\mt5\order_completion.py') `
    -ErrorCode 'native_source_completion_source_missing'
$workerDirectory = Assert-PathWithinRoot `
    -Path (Join-Path $debugRoot 'modules\adapter.mt5.python') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
Assert-NotReparsePoint -Path $workerDirectory -ErrorCode 'native_source_debug_path_invalid'
if (-not (Test-Path -LiteralPath $workerDirectory -PathType Container)) {
    try {
        New-Item -ItemType Directory -Path $workerDirectory -Force | Out-Null
    }
    catch {
        Stop-WithStableError 'native_source_sync_failed' $workerDirectory
    }
}

$runtimeDirectory = Assert-PathWithinRoot `
    -Path (Join-Path $debugRoot 'runtime\python') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
Assert-NotReparsePoint -Path $runtimeDirectory -ErrorCode 'native_source_debug_path_invalid'
$runtimePython = Resolve-ExistingFile `
    -Path (Join-Path $runtimeDirectory 'python.exe') `
    -ErrorCode 'native_source_runtime_python_missing'
Assert-NotReparsePoint -Path $runtimePython -ErrorCode 'native_source_debug_path_invalid'
$runtimeMetadata = Resolve-ExistingFile `
    -Path (Join-Path $runtimeDirectory 'runtime-metadata.json') `
    -ErrorCode 'native_source_runtime_metadata_missing'
Assert-NotReparsePoint -Path $runtimeMetadata -ErrorCode 'native_source_debug_path_invalid'
try {
    $runtimeMetadataPayload = Get-Content -LiteralPath $runtimeMetadata -Raw -Encoding UTF8 |
        ConvertFrom-Json
}
catch {
    Stop-WithStableError 'native_source_runtime_metadata_invalid'
}
if ($runtimeMetadataPayload.schema_version -ne 1 -or
    $runtimeMetadataPayload.architecture -ne 'win-x64' -or
    $runtimeMetadataPayload.python_version -notmatch '^3\.11\.\d+$' -or
    $runtimeMetadataPayload.metatrader5_version -notmatch '^\d+\.\d+\.\d+$' -or
    $runtimeMetadataPayload.numpy_version -notmatch '^\d+\.\d+\.\d+$') {
    Stop-WithStableError 'native_source_runtime_metadata_invalid'
}
$sitePackages = Assert-PathWithinRoot `
    -Path (Join-Path $runtimeDirectory 'Lib\site-packages') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
Assert-NotReparsePoint -Path $sitePackages -ErrorCode 'native_source_debug_path_invalid'
$mt5Package = Assert-PathWithinRoot `
    -Path (Join-Path $sitePackages 'MetaTrader5') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
Assert-NotReparsePoint -Path $mt5Package -ErrorCode 'native_source_debug_path_invalid'
$numpyPackage = Assert-PathWithinRoot `
    -Path (Join-Path $sitePackages 'numpy') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
Assert-NotReparsePoint -Path $numpyPackage -ErrorCode 'native_source_debug_path_invalid'
if (-not (Test-Path -LiteralPath (Join-Path $mt5Package '__init__.py') -PathType Leaf) -or
    -not (Get-ChildItem -LiteralPath $mt5Package -Filter '*.pyd' -File -ErrorAction SilentlyContinue) -or
    -not (Test-Path -LiteralPath (Join-Path $numpyPackage '__init__.py') -PathType Leaf)) {
    Stop-WithStableError 'native_source_mt5_dependency_missing'
}
& $runtimePython -I -c 'import MetaTrader5, numpy' | Out-Null
if ($LASTEXITCODE -ne 0) {
    Stop-WithStableError 'native_source_runtime_import_failed'
}

$debugEndpoints = Assert-PathWithinRoot `
    -Path (Join-Path $debugRoot 'server-endpoints.json') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
$debugWorker = Assert-PathWithinRoot `
    -Path (Join-Path $workerDirectory 'worker.py') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
$debugTrade = Assert-PathWithinRoot `
    -Path (Join-Path $workerDirectory 'trade.py') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
$debugCompletion = Assert-PathWithinRoot `
    -Path (Join-Path $workerDirectory 'order_completion.py') `
    -Root $repoRoot `
    -ErrorCode 'native_source_debug_path_invalid'
foreach ($destination in @($debugWorker, $debugTrade, $debugCompletion, $debugEndpoints)) {
    Assert-NotReparsePoint -Path $destination -ErrorCode 'native_source_debug_path_invalid'
}
try {
    Copy-Item -LiteralPath $workerSource -Destination $debugWorker -Force
    Copy-Item -LiteralPath $tradeSource -Destination $debugTrade -Force
    Copy-Item -LiteralPath $completionSource -Destination $debugCompletion -Force
    Copy-Item -LiteralPath $developmentEndpoints -Destination $debugEndpoints -Force
}
catch {
    Stop-WithStableError 'native_source_sync_failed'
}

Assert-NoDebugBridgeProcess -UiPath $debugUi -CorePath $debugCore
Write-Host "启动源码 Debug Bridge: $debugUi"
Write-Host "内置 Python Runtime: $runtimePython"
Write-Host "服务端点: http://127.0.0.1:3000"
Push-Location $debugRoot
try {
    & $debugUi
    if ($LASTEXITCODE -ne 0) {
        Stop-WithStableError 'native_source_ui_exit_failed' $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
