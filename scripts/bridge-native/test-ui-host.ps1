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
$launcherProcess = $null
$coreProcesses = @()
$savedAppData = $env:APPDATA
$savedLocalAppData = $env:LOCALAPPDATA

try {
  if (-not $SkipBuild) {
    Push-Location $nativeRoot
    try {
      & $cargo build --locked --release -p liangjian-bridge-core -p liangjian-bridge-launcher `
        -p liangjian-bridge-ui
      if ($LASTEXITCODE -ne 0) {
        throw 'native_ui_host_build_failed'
      }
    }
    finally {
      Pop-Location
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
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'liangjian-bridge-launcher.exe') `
    -Destination (Join-Path $testRoot 'AURUMBridge.Launcher.exe')
  Copy-Item -LiteralPath (Join-Path $releaseRoot 'liangjian-bridge-core.exe') `
    -Destination (Join-Path $versionDirectory 'runtime\python\python.exe')
  Copy-Item -LiteralPath (Join-Path $nativeRoot 'workers\mt5\worker.py') `
    -Destination (Join-Path $versionDirectory 'modules\adapter.mt5.python\worker.py')
  Copy-Item -LiteralPath (Join-Path $nativeRoot 'config\development\server-endpoints.json') `
    -Destination (Join-Path $versionDirectory 'server-endpoints.json')
  $pointerPayload = [ordered]@{
    active_version = '3.0.0'
    last_known_good_version = '3.0.0'
    status = 'healthy'
    expected_terminal_instance_ids = @()
    updated_at_utc_msc = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText(
    (Join-Path $testRoot 'current.json'),
    $pointerPayload,
    [Text.UTF8Encoding]::new($false))

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

  $knownUiProcessIds = @(
    Get-CimInstance Win32_Process -Filter "Name='AURUMBridge.exe'" -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty ProcessId
  )
  $launcherProcess = Start-Process `
    -FilePath (Join-Path $testRoot 'AURUMBridge.Launcher.exe') `
    -ArgumentList '--autostart' `
    -WindowStyle Hidden `
    -PassThru
  $launcherDeadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $launcherProcess.Refresh()
  } while (-not $launcherProcess.HasExited -and
    [DateTimeOffset]::UtcNow -lt $launcherDeadline)
  if (-not $launcherProcess.HasExited) {
    throw 'native_launcher_process_timeout'
  }
  if ($launcherProcess.ExitCode -ne 0) {
    throw "native_launcher_start_failed exit=$($launcherProcess.ExitCode)"
  }
  $uiDeadline = [DateTimeOffset]::UtcNow.AddSeconds(8)
  do {
    $uiCandidate = Get-CimInstance Win32_Process -Filter "Name='AURUMBridge.exe'" `
      -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -notin $knownUiProcessIds -and
        -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        [string]::Equals(
          [IO.Path]::GetFullPath($_.ExecutablePath),
          [IO.Path]::GetFullPath((Join-Path $versionDirectory 'AURUMBridge.exe')),
          [StringComparison]::OrdinalIgnoreCase)
      } |
      Select-Object -First 1
    if ($null -eq $uiCandidate) {
      Start-Sleep -Milliseconds 200
    }
  } while ($null -eq $uiCandidate -and [DateTimeOffset]::UtcNow -lt $uiDeadline)
  if ($null -eq $uiCandidate) {
    throw 'native_launcher_ui_process_missing'
  }
  $uiProcess = Get-Process -Id $uiCandidate.ProcessId -ErrorAction Stop
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
  $pointer = Get-Content -Raw -Encoding UTF8 (Join-Path $testRoot 'current.json') |
    ConvertFrom-Json
  if ($pointer.active_version -ne '3.0.0' -or
      $pointer.last_known_good_version -ne '3.0.0' -or
      $pointer.status -ne 'healthy' -or
      @($pointer.expected_terminal_instance_ids).Count -ne 0) {
    throw 'native_launcher_pointer_invalid'
  }

  [pscustomobject]@{
    LauncherEntry = 'passed'
    HealthForwarding = 'passed'
    MinimizedUiAlive = $true
    CoreChildCount = $coreProcesses.Count
    ServerUrl = $endpoint
  } | ConvertTo-Json -Compress
}
finally {
  if ($null -ne $launcherProcess) {
    $launcherProcess.Refresh()
    if (-not $launcherProcess.HasExited) {
      Stop-Process -Id $launcherProcess.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $launcherProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
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
