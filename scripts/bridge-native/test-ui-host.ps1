param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nativeRoot = Join-Path $repoRoot 'bridge\native'
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$releaseRoot = Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\release'
$testRoot = Join-Path $env:TEMP ('liangjian-native-ui-host-' + [Guid]::NewGuid().ToString('N'))
$versionDirectory = Join-Path $testRoot 'versions\3.0.0'
$healthDirectory = Join-Path $testRoot 'health'
$testAppData = Join-Path $testRoot 'appdata'
$testLocalAppData = Join-Path $testRoot 'localappdata'
$uiProcess = $null
$coreProcesses = @()
$savedAppData = $env:APPDATA
$savedLocalAppData = $env:LOCALAPPDATA

try {
  if (-not $SkipBuild) {
    & $cargo build --locked --release -p liangjian-bridge-core -p liangjian-bridge-ui `
      --manifest-path (Join-Path $nativeRoot 'Cargo.toml')
    if ($LASTEXITCODE -ne 0) {
      throw 'native_ui_host_build_failed'
    }
  }

  $directories = @(
    $versionDirectory,
    $healthDirectory,
    $testAppData,
    $testLocalAppData,
    (Join-Path $versionDirectory 'runtime\python'),
    (Join-Path $versionDirectory 'modules\adapter.mt5.python')
  )
  New-Item -ItemType Directory -Path $directories -Force | Out-Null

  Copy-Item -LiteralPath (Join-Path $releaseRoot 'liangjian-bridge-ui.exe') `
    -Destination (Join-Path $versionDirectory 'AURUMBridge.exe')
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'liangjian-bridge-core.exe') `
    -Destination (Join-Path $versionDirectory 'AURUMBridge.Core.exe')
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'liangjian-bridge-core.exe') `
    -Destination (Join-Path $versionDirectory 'runtime\python\python.exe')
  Copy-Item -LiteralPath (Join-Path $nativeRoot 'workers\mt5\worker.py') `
    -Destination (Join-Path $versionDirectory 'modules\adapter.mt5.python\worker.py')
  Copy-Item -LiteralPath (Join-Path $nativeRoot 'config\development\server-endpoints.json') `
    -Destination (Join-Path $versionDirectory 'server-endpoints.json')

  $endpoint = (Get-Content -Raw -Encoding UTF8 `
    (Join-Path $versionDirectory 'server-endpoints.json') | ConvertFrom-Json).server_url
  if ($endpoint -ne 'http://127.0.0.1:3000') {
    throw 'native_ui_host_endpoint_not_local'
  }

  $env:APPDATA = $testAppData
  $env:LOCALAPPDATA = $testLocalAppData
  $healthFile = Join-Path $healthDirectory 'health-ui-host-smoke.json'
  $healthProcess = Start-Process `
    -FilePath (Join-Path $versionDirectory 'AURUMBridge.exe') `
    -ArgumentList @('--health-check', '--health-file', $healthFile) `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  $uiHealthExitCode = $healthProcess.ExitCode
  if ($uiHealthExitCode -ne 0 -or -not (Test-Path -LiteralPath $healthFile)) {
    $directHealthFile = Join-Path $healthDirectory 'health-core-diagnostic.json'
    & (Join-Path $versionDirectory 'AURUMBridge.Core.exe') `
      --health-check --health-file $directHealthFile
    $coreHealthExitCode = $LASTEXITCODE
    throw "native_ui_host_health_forwarding_failed ui=$uiHealthExitCode core=$coreHealthExitCode"
  }
  $health = Get-Content -Raw -Encoding UTF8 $healthFile | ConvertFrom-Json
  if (-not $health.ok -or $health.implementation -ne 'rust-native-foundation') {
    throw 'native_ui_host_health_payload_invalid'
  }

  $uiProcess = Start-Process `
    -FilePath (Join-Path $versionDirectory 'AURUMBridge.exe') `
    -ArgumentList '--start-minimized' `
    -WindowStyle Hidden `
    -PassThru
  Start-Sleep -Seconds 3
  $uiProcess.Refresh()
  if ($uiProcess.HasExited) {
    throw 'native_ui_host_process_exited'
  }
  $coreProcesses = @(
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($uiProcess.Id)" |
      Where-Object { $_.Name -ieq 'AURUMBridge.Core.exe' }
  )
  if ($coreProcesses.Count -ne 1) {
    throw 'native_ui_host_core_child_invalid'
  }

  [pscustomobject]@{
    HealthForwarding = 'passed'
    MinimizedUiAlive = $true
    CoreChildCount = $coreProcesses.Count
    ServerUrl = $endpoint
  } | ConvertTo-Json -Compress
}
finally {
  if ($null -ne $uiProcess) {
    $uiProcess.Refresh()
    if (-not $uiProcess.HasExited) {
      Stop-Process -Id $uiProcess.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $uiProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
  foreach ($coreProcess in $coreProcesses) {
    Stop-Process -Id $coreProcess.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $coreProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  }
  $env:APPDATA = $savedAppData
  $env:LOCALAPPDATA = $savedLocalAppData

  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $resolvedTestRoot.StartsWith(
      $resolvedTempRoot + 'liangjian-native-ui-host-',
      [StringComparison]::OrdinalIgnoreCase)) {
    throw 'native_ui_host_cleanup_path_invalid'
  }
  if (Test-Path -LiteralPath $resolvedTestRoot) {
    $removed = $false
    foreach ($attempt in 1..10) {
      try {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
        $removed = $true
        break
      }
      catch {
        if ($attempt -eq 10) {
          throw
        }
        Start-Sleep -Milliseconds 250
      }
    }
    if (-not $removed) {
      throw 'native_ui_host_cleanup_failed'
    }
  }
}
