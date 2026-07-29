[CmdletBinding()]
param(
    [switch]$SkipRelease
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nativeRoot = Join-Path $repo 'bridge\native'
$manifest = Join-Path $nativeRoot 'Cargo.toml'
$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargo = if ($null -ne $cargoCommand) {
    $cargoCommand.Source
} else {
    Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
if (-not (Test-Path -LiteralPath $cargo)) {
    throw 'rust_cargo_not_installed'
}

Push-Location $nativeRoot
try {
    & $cargo fmt --manifest-path $manifest --all --check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $cargo clippy --manifest-path $manifest --workspace --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & $cargo test --manifest-path $manifest --workspace
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipRelease) {
        & $cargo build --manifest-path $manifest --workspace --release
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    Pop-Location
}
