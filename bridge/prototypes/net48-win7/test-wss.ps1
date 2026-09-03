param(
    [string]$Uri = 'wss://ws.postman-echo.com/raw'
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $prototypeRoot 'artifacts\LiangjianBridge.WssProbe.exe'

if (-not (Test-Path -LiteralPath $probe)) {
    & (Join-Path $prototypeRoot 'build.ps1')
}

& $probe $Uri
if ($LASTEXITCODE -ne 0) {
    throw "bridge_prototype_wss_failed: $LASTEXITCODE"
}
