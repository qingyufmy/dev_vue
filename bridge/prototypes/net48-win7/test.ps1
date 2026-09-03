param(
    [ValidateSet('x86', 'x64')]
    [string]$Platform = 'x86'
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tests = Join-Path $prototypeRoot 'artifacts\LiangjianBridge.SmokeTests.exe'

if (-not (Test-Path -LiteralPath $tests)) {
    & (Join-Path $prototypeRoot 'build.ps1') -Platform $Platform
}

& $tests
if ($LASTEXITCODE -ne 0) {
    throw "bridge_prototype_smoke_failed: $LASTEXITCODE"
}
