param(
    [ValidateSet('x86', 'x64')]
    [string]$Platform = 'x86',
    [ValidateSet('artifacts', 'artifacts-review')]
    [string]$BuildDirectoryName = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$tests = Join-Path (Join-Path $prototypeRoot $BuildDirectoryName) 'LiangjianBridge.SmokeTests.exe'

if (-not (Test-Path -LiteralPath $tests)) {
    & (Join-Path $prototypeRoot 'build.ps1') -Platform $Platform -BuildDirectoryName $BuildDirectoryName
}

& $tests
if ($LASTEXITCODE -ne 0) {
    throw "bridge_prototype_smoke_failed: $LASTEXITCODE"
}
