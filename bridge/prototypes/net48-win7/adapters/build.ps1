param(
  [string]$Mt4MetaEditor = 'C:\Program Files (x86)\MetaTrader 4\metaeditor.exe'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Compile-MqlSource {
  param(
    [string]$Editor,
    [string]$Source,
    [string]$Label
  )

  if(-not (Test-Path -LiteralPath $Editor)) {
    throw "$Label MetaEditor not found: $Editor"
  }
  if(-not (Test-Path -LiteralPath $Source)) {
    throw "$Label source not found: $Source"
  }

  $log = [System.IO.Path]::ChangeExtension($Source, '.log')
  $extension = '.ex5'
  if($Label -eq 'MT4') { $extension = '.ex4' }
  $binary = [System.IO.Path]::ChangeExtension($Source, $extension)
  Remove-Item -LiteralPath $log,$binary -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $Editor -ArgumentList @(
    "/compile:$Source",
    '/log'
  ) -Wait -PassThru
  if(-not (Test-Path -LiteralPath $log)) {
    throw "$Label MetaEditor did not write a compile log (process exit $($process.ExitCode))"
  }
  $result = Get-Content -Raw -LiteralPath $log
  if($result -notmatch 'Result:\s*0 errors,\s*0 warnings') {
    throw "$Label compile failed:`n$result"
  }
  Write-Host "${Label}: 0 errors, 0 warnings"
  Write-Host "  log: $log"
}

Compile-MqlSource $Mt4MetaEditor (Join-Path $root 'mt4\BridgeV4MT4.mq4') 'MT4'
Write-Host 'MT4 MQL source compilation passed. MT5 uses the official Python integration worker.'
