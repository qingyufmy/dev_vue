[CmdletBinding()]
param(
    [switch]$SkipRelease
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nativeRoot = Join-Path $repo 'bridge\native'
$manifest = Join-Path $nativeRoot 'Cargo.toml'
$pythonTests = Join-Path $nativeRoot 'workers\mt5\tests'
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
    & $cargo fmt --manifest-path $manifest --all --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $cargo clippy --locked --manifest-path $manifest --workspace --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $cargo test --locked --manifest-path $manifest --workspace
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipRelease) {
        & $cargo build --locked --manifest-path $manifest --workspace --release
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    Pop-Location
}
