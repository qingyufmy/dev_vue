[CmdletBinding()]
param(
    [switch]$SkipRelease
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nativeRoot = Join-Path $repo 'bridge\native'
$manifest = Join-Path $nativeRoot 'Cargo.toml'
$pythonTests = Join-Path $nativeRoot 'workers\mt5\tests'
$developmentEndpoints = Join-Path $nativeRoot 'config\development\server-endpoints.json'
$developmentEndpointConfig = Get-Content -LiteralPath $developmentEndpoints -Raw |
    ConvertFrom-Json
if ($developmentEndpointConfig.schema_version -ne 1 -or
    $developmentEndpointConfig.server_url -ne 'http://127.0.0.1:3000') {
    throw 'native_development_endpoint_must_be_loopback'
}
$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargo = if ($null -ne $cargoCommand) {
    $cargoCommand.Source
} else {
    Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
if (-not (Test-Path -LiteralPath $cargo)) {
    throw 'rust_cargo_not_installed'
}
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    throw 'python_runtime_not_installed'
}

& $pythonCommand.Source -m unittest discover -s $pythonTests -p 'test_*.py'
if ($LASTEXITCODE -ne 0) { throw 'mt5_worker_python_tests_failed' }
& $pythonCommand.Source -m compileall -q (Join-Path $nativeRoot 'workers\mt5')
if ($LASTEXITCODE -ne 0) { throw 'mt5_worker_python_compile_failed' }

Push-Location $nativeRoot
try {
    $debugDirectory = Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\debug'
    New-Item -ItemType Directory -Path $debugDirectory -Force | Out-Null
    Copy-Item -LiteralPath $developmentEndpoints `
        -Destination (Join-Path $debugDirectory 'server-endpoints.json') `
        -Force
    $debugPython = Join-Path $debugDirectory 'runtime\python\python.exe'
    $debugWorker = Join-Path $debugDirectory 'modules\adapter.mt5.python\worker.py'
    New-Item -ItemType Directory -Path (Split-Path $debugPython -Parent) -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path $debugWorker -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $pythonCommand.Source -Destination $debugPython -Force
    Copy-Item -LiteralPath (Join-Path $nativeRoot 'workers\mt5\worker.py') `
        -Destination $debugWorker `
        -Force

    & $cargo fmt --manifest-path $manifest --all --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $cargo clippy --locked --manifest-path $manifest --workspace --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $cargo test --locked --manifest-path $manifest --workspace
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipRelease) {
        & $cargo build --locked --manifest-path $manifest --workspace --release
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        $releaseDirectory = Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\release'
        $releaseCore = Join-Path $releaseDirectory 'liangjian-bridge-core.exe'
        $releaseLauncher = Join-Path $releaseDirectory 'liangjian-bridge-launcher.exe'
        if (-not (Test-Path -LiteralPath $releaseCore)) {
            throw 'native_release_core_not_found'
        }
        if (-not (Test-Path -LiteralPath $releaseLauncher)) {
            throw 'native_release_launcher_not_found'
        }
        Copy-Item -LiteralPath $developmentEndpoints `
            -Destination (Join-Path $releaseDirectory 'server-endpoints.json') `
            -Force
        Write-Host 'Native development endpoint: http://127.0.0.1:3000'
    }
} finally {
    Pop-Location
}
