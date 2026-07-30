param(
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$ManifestPath,
  [string]$ServerUrl = 'http://127.0.0.1:3000',
  [string]$LauncherVersion,
  [ValidateRange(1,3650)][int]$MinimumOfflineValidityDays = 90,
  [ValidateRange(1,512)][int]$MaximumInstallerSizeMiB = 50,
  [string]$InnoCompiler,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Read-Json([string]$Path, [string]$ErrorCode) {
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    throw $ErrorCode
  }
}

function Invoke-Installer([string]$Executable, [string]$LogPath, [string]$ResultPath) {
  $logArgument = '/LOG="' + $LogPath + '"'
  $process = Start-Process -FilePath $Executable `
    -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',$logArgument) `
    -Wait -PassThru -WindowStyle Hidden
  if (-not (Test-Path -LiteralPath $ResultPath -PathType Leaf)) {
    throw 'local_installer_result_missing'
  }
  $result = Read-Json $ResultPath 'local_installer_result_invalid'
  if ($process.ExitCode -ne 0 -or $result.ok -ne $true -or
    $result.operation -ne 'bootstrap-install-rehearsal') {
    throw 'local_installer_execution_failed'
  }
  return $result
}

$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$publicKeyPath = (Resolve-Path -LiteralPath $PublicKey).Path
$manifestFile = if ($ManifestPath) {
  (Resolve-Path -LiteralPath $ManifestPath).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $releaseRoot 'manifest.signed.json')).Path
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'local_installer_output_exists' }
$serverUri = $null
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$serverUri) -or
  $serverUri.Scheme -ne 'http' -or -not $serverUri.IsLoopback -or
  $serverUri.UserInfo -or $serverUri.Query -or $serverUri.Fragment -or
  $serverUri.AbsolutePath -ne '/') {
  throw 'local_installer_server_must_be_loopback'
}
$serverUrlValue = $serverUri.GetLeftPart([UriPartial]::Authority)
$manifest = Read-Json $manifestFile 'local_installer_manifest_invalid'
$releaseVersion = [string]$manifest.release_version
$parsedVersion = $null
if (-not [Version]::TryParse($releaseVersion, [ref]$parsedVersion) -or
  $releaseVersion.Contains('-') -or $releaseVersion.Contains('+')) {
  throw 'local_installer_version_invalid'
}
if (-not $LauncherVersion) { $LauncherVersion = $releaseVersion }
if ($LauncherVersion -ne $releaseVersion) { throw 'local_installer_version_mismatch' }

$installerOutput = Join-Path $outputRoot 'installer'
$installRoot = Join-Path $outputRoot 'installed'
$buildArguments = @{
  OutputDirectory = $installerOutput
  ReleaseDirectory = $releaseRoot
  ManifestPath = $manifestFile
  PublicKey = $publicKeyPath
  ServerUrl = $serverUrlValue
  LauncherVersion = $LauncherVersion
  TargetEnvironment = 'test'
  MinimumOfflineValidityDays = $MinimumOfflineValidityDays
  TestRehearsalInstallRoot = $installRoot
  DryRun = $DryRun
}
if ($InnoCompiler) { $buildArguments.InnoCompiler = $InnoCompiler }
$buildOutput = @(& (Join-Path $PSScriptRoot 'build-full-installer.ps1') @buildArguments)
$buildSucceeded = $?
if (-not $buildSucceeded -or $buildOutput.Count -eq 0) {
  throw 'local_installer_build_failed'
}
try {
  $buildResult = $buildOutput[-1] | ConvertFrom-Json
} catch {
  throw 'local_installer_build_result_invalid'
}
if ($buildResult.ok -ne $true) { throw 'local_installer_build_failed' }
if ($DryRun) {
  [pscustomobject]@{
    ok=$true
    operation='test-local-full-installer'
    dry_run=$true
    release_version=$releaseVersion
    server_url=$serverUrlValue
    output=$outputRoot
    build_ready=[bool]$buildResult.build_ready
  } | ConvertTo-Json
  exit 0
}

$installer = Join-Path $installerOutput 'LiangjianBridgeSetup.exe'
$metadataPath = Join-Path $installerOutput 'bootstrapper-metadata.json'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
  -not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
  throw 'local_installer_build_output_missing'
}
$metadata = Read-Json $metadataPath 'local_installer_metadata_invalid'
$maximumInstallerBytes = [long]$MaximumInstallerSizeMiB * 1024 * 1024
if ($metadata.schema_version -ne 1 -or $metadata.environment -ne 'test' -or
  $metadata.release_version -ne $releaseVersion -or
  $metadata.installer_size_bytes -ne (Get-Item -LiteralPath $installer).Length -or
  [long]$metadata.installer_size_bytes -gt $maximumInstallerBytes -or
  [string]$metadata.rehearsal_install_root -ne $installRoot -or
  [string]$metadata.rehearsal_result_path -ne "$installRoot.install-result.json") {
  throw 'local_installer_metadata_invalid'
}

$resultPath = "$installRoot.install-result.json"
$first = Invoke-Installer $installer (Join-Path $outputRoot 'install-first.log') $resultPath
if ($first.version -ne $releaseVersion -or [string]$first.install_root -ne $installRoot) {
  throw 'local_installer_result_invalid'
}
$versionRoot = Join-Path $installRoot "versions\$releaseVersion"
$pointerPath = Join-Path $installRoot 'current.json'
$pointerBefore = Read-Json $pointerPath 'local_installer_pointer_invalid'
$sentinel = Join-Path $versionRoot 'repair-sentinel.tmp'
[IO.File]::WriteAllBytes($sentinel, [byte[]](1,2,3,4))
$repair = Invoke-Installer $installer (Join-Path $outputRoot 'install-repair.log') $resultPath
$pointerAfter = Read-Json $pointerPath 'local_installer_pointer_invalid'
$repairBackups = @(Get-ChildItem -LiteralPath (Join-Path $installRoot 'versions') -Force |
  Where-Object { $_.Name -like '.repair-backup-*' })
if ($repair.version -ne $releaseVersion -or (Test-Path -LiteralPath $sentinel) -or
  $repairBackups.Count -ne 0 -or
  [long]$pointerAfter.updated_at_utc_msc -le [long]$pointerBefore.updated_at_utc_msc -or
  $pointerAfter.active_version -ne $releaseVersion -or
  $pointerAfter.last_known_good_version -ne $releaseVersion -or
  $pointerAfter.status -ne 'healthy') {
  throw 'local_installer_repair_failed'
}

$requiredFiles = @(
  'AURUMBridge.exe',
  'AURUMBridge.Core.exe',
  'server-endpoints.json',
  'runtime\python\python.exe',
  'launcher\AURUMBridge.Launcher.exe',
  'modules\adapter.mt5.python\worker.py',
  'modules\adapter.mt5.python\trade.py',
  'modules\adapter.mt4\AURUMBridgeEA.ex4',
  'compliance\bridge-native.spdx.json',
  'compliance\THIRD-PARTY-LICENSES.txt',
  'compliance\native-dependency-audit.json',
  '.aurum-release.json'
)
if ($requiredFiles | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $versionRoot $_) -PathType Leaf)
}) {
  throw 'local_installer_layout_invalid'
}
$endpoint = Read-Json (Join-Path $versionRoot 'server-endpoints.json') 'local_installer_endpoint_invalid'
if ($endpoint.schema_version -ne 1 -or $endpoint.server_url -ne $serverUrlValue) {
  throw 'local_installer_endpoint_invalid'
}
$installedManifest = Read-Json (Join-Path $versionRoot '.aurum-release.json') 'local_installer_manifest_invalid'
foreach ($package in $installedManifest.packages) {
  $packageUri = $null
  if (-not [Uri]::TryCreate([string]$package.url, [UriKind]::Absolute, [ref]$packageUri) -or
    $packageUri.Scheme -ne 'http' -or -not $packageUri.IsLoopback -or
    $packageUri.GetLeftPart([UriPartial]::Authority) -ne $serverUrlValue) {
    throw 'local_installer_remote_package_present'
  }
}

$allFiles = @(Get-ChildItem -LiteralPath $installRoot -Recurse -Force -File)
$forbiddenExtensions = @('.pdb','.d','.rlib','.lib','.exp','.obj','.ilk','.map','.pyc')
$forbiddenNames = @(
  'libssl-3-x64.dll','libcrypto-3-x64.dll','_ssl.pyd','_hashlib.pyd',
  'hostfxr.dll','coreclr.dll','AURUMBridge.dll','AURUMBridge.deps.json',
  'AURUMBridge.runtimeconfig.json','e_sqlite3.dll','Microsoft.Data.Sqlite.dll'
)
if ($allFiles | Where-Object {
  $_.Extension.ToLowerInvariant() -in $forbiddenExtensions -or
  $_.Name -in $forbiddenNames
}) {
  throw 'local_installer_forbidden_file_present'
}
$forbiddenHostFiles = [Collections.Generic.List[string]]::new()
foreach ($file in $allFiles) {
  $content = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($file.FullName))
  if ($content.IndexOf('cnfxtrade.com', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    $forbiddenHostFiles.Add($file.FullName)
  }
}
if ($forbiddenHostFiles.Count -ne 0) { throw 'local_installer_remote_host_present' }

$executables = @(
  (Join-Path $versionRoot 'AURUMBridge.exe'),
  (Join-Path $versionRoot 'AURUMBridge.Core.exe'),
  (Join-Path $versionRoot 'launcher\AURUMBridge.Launcher.exe'),
  (Join-Path $installRoot 'AURUMBridge.Launcher.exe')
)
if ($executables | Where-Object {
  (Get-Item -LiteralPath $_).VersionInfo.ProductVersion -ne $releaseVersion
}) {
  throw 'local_installer_version_mismatch'
}
$workerText = Get-Content -LiteralPath `
  (Join-Path $versionRoot 'modules\adapter.mt5.python\worker.py') -Raw -Encoding utf8
if ($workerText -notmatch "(?m)^WORKER_VERSION = `"$([Regex]::Escape($releaseVersion))`"$") {
  throw 'local_installer_version_mismatch'
}

$healthDirectory = Join-Path $installRoot 'health'
New-Item -ItemType Directory -Path $healthDirectory -Force | Out-Null
$healthPath = Join-Path $healthDirectory 'health-local-full-installer.json'
$dataDirectory = Join-Path $outputRoot 'isolated-data'
$previousDataDirectory = $env:AURUM_BRIDGE_DATA_DIR
try {
  $env:AURUM_BRIDGE_DATA_DIR = $dataDirectory
  $healthArgument = '"' + $healthPath + '"'
  $healthProcess = Start-Process -FilePath (Join-Path $versionRoot 'AURUMBridge.Core.exe') `
    -ArgumentList @('--health-check','--health-file',$healthArgument) `
    -Wait -PassThru -WindowStyle Hidden
} finally {
  $env:AURUM_BRIDGE_DATA_DIR = $previousDataDirectory
}
if ($healthProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $healthPath -PathType Leaf)) {
  throw 'local_installer_health_failed'
}
$health = Read-Json $healthPath 'local_installer_health_failed'
if ($health.ok -ne $true -or $health.version -ne $releaseVersion -or
  $health.implementation -ne 'rust-native-foundation' -or
  @($health.checks).Count -ne 3 -or
  @($health.checks | Where-Object {
    $_ -in @('runtime_files','sqlite_wal','data_directory_write')
  }).Count -ne 3) {
  throw 'local_installer_health_failed'
}

$resultDocument = [ordered]@{
  ok=$true
  operation='test-local-full-installer'
  release_version=$releaseVersion
  server_url=$serverUrlValue
  installer=$installer
  installer_size_bytes=[long]$metadata.installer_size_bytes
  installer_sha256=[string]$metadata.installer_sha256
  install_root=$installRoot
  installed_file_count=$allFiles.Count
  installed_size_bytes=($allFiles | Measure-Object Length -Sum).Sum
  repair_verified=$true
  health_checks=@($health.checks)
  remote_host_matches=0
  generated_at_utc=(Get-Date).ToUniversalTime().ToString('o')
}
$resultJson = $resultDocument | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText(
  (Join-Path $outputRoot 'lifecycle-result.json'),
  $resultJson,
  [Text.UTF8Encoding]::new($false)
)
$resultJson
