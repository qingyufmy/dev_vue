param(
  [Parameter(Mandatory=$true)][string]$ReleaseVersion,
  [Parameter(Mandatory=$true)][ValidateSet('normal','urgent')][string]$Priority,
  [Parameter(Mandatory=$true)][ValidateSet('internal','stable')][string]$RolloutChannel,
  [Parameter(Mandatory=$true)][ValidateRange(1,100)][int]$RolloutPercentage,
  [Parameter(Mandatory=$true)][string]$PythonRuntimeDirectory,
  [Parameter(Mandatory=$true)][string]$CdnDomain,
  [string]$ServerUrl = 'http://127.0.0.1:3000',
  [string]$ReleaseId,
  [string]$OutputDirectory,
  [int]$MinimumIdleSeconds = 120,
  [string]$MinimumLauncherVersion = '1.0.0',
  [Nullable[long]]$ActivationDeadlineUtcMsc = $null,
  [string]$ReleaseNotes = '',
  [int]$ExpiresInDays = 30,
  [ValidateSet('test','production')][string]$TargetEnvironment = 'test',
  [string]$MetaEditorExe = $env:AURUM_METAEDITOR_EXE,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}
function Assert-NativeReleaseLayout(
  [string]$CoreDirectory,
  [string]$Mt5Directory,
  [string]$Mt4Directory,
  [string]$LauncherPath
) {
  $required = @(
    (Join-Path $CoreDirectory 'AURUMBridge.exe'),
    (Join-Path $CoreDirectory 'AURUMBridge.Core.exe'),
    (Join-Path $CoreDirectory 'server-endpoints.json'),
    (Join-Path $CoreDirectory 'runtime\python\python.exe'),
    (Join-Path $CoreDirectory 'compliance\bridge-native.spdx.json'),
    (Join-Path $CoreDirectory 'compliance\THIRD-PARTY-LICENSES.txt'),
    (Join-Path $CoreDirectory 'compliance\native-dependency-audit.json'),
    (Join-Path $Mt5Directory 'worker.py'),
    (Join-Path $Mt5Directory 'trade.py'),
    (Join-Path $Mt4Directory 'AURUMBridgeEA.ex4'),
    $LauncherPath
  )
  if ($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
    throw 'release_native_layout_incomplete'
  }
  $legacyDotNetFiles = @(
    'AURUMBridge.dll',
    'AURUMBridge.deps.json',
    'AURUMBridge.runtimeconfig.json',
    'hostfxr.dll',
    'coreclr.dll',
    'e_sqlite3.dll',
    'Microsoft.Data.Sqlite.dll'
  )
  if ($legacyDotNetFiles | Where-Object {
    Test-Path -LiteralPath (Join-Path $CoreDirectory $_) -PathType Leaf
  }) {
    throw 'release_legacy_dotnet_artifact_present'
  }
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$branch = git -C $repo branch --show-current
$commit = git -C $repo rev-parse HEAD
$dirty = [bool](git -C $repo status --porcelain)
if ($TargetEnvironment -eq 'production' -and $dirty) { throw 'release_production_worktree_dirty' }
$parsedVersion = $null
if (-not [Version]::TryParse($ReleaseVersion, [ref]$parsedVersion)) { throw 'release_version_invalid' }
if ($MinimumIdleSeconds -lt 30 -or $MinimumIdleSeconds -gt 3600) { throw 'release_minimum_idle_invalid' }
$pythonRoot = (Resolve-Path -LiteralPath $PythonRuntimeDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $pythonRoot 'python.exe') -PathType Leaf)) { throw 'release_python_runtime_invalid' }
if ((Test-Path -LiteralPath (Join-Path $pythonRoot 'pyvenv.cfg')) -or
  (Test-Path -LiteralPath (Join-Path (Split-Path $pythonRoot -Parent) 'pyvenv.cfg'))) { throw 'release_python_runtime_not_portable' }
if ($TargetEnvironment -eq 'production') {
  $runtimeMetadataPath = Join-Path $pythonRoot 'runtime-metadata.json'
  if (-not (Test-Path -LiteralPath $runtimeMetadataPath -PathType Leaf)) { throw 'release_python_runtime_metadata_missing' }
  $runtimeMetadata = Get-Content -LiteralPath $runtimeMetadataPath -Raw | ConvertFrom-Json
  if ($runtimeMetadata.schema_version -ne 1 -or $runtimeMetadata.architecture -ne 'win-x64' -or -not ([string]$runtimeMetadata.python_version).StartsWith('3.11.')) { throw 'release_python_runtime_metadata_invalid' }
}
if ($TargetEnvironment -eq 'production' -and (-not $MetaEditorExe -or -not (Test-Path -LiteralPath $MetaEditorExe -PathType Leaf))) { throw 'release_metaeditor_required' }
$domain = $CdnDomain.TrimEnd('/')
$domainUri = $null
if (-not [Uri]::TryCreate($domain, [UriKind]::Absolute, [ref]$domainUri)) { throw 'release_cdn_domain_invalid' }
if ($TargetEnvironment -eq 'production' -and $ServerUrl -eq 'http://127.0.0.1:3000') {
  throw 'release_production_server_url_required'
}
$localTestCdn = $TargetEnvironment -eq 'test' -and
  $domainUri.Scheme -eq 'http' -and $domainUri.IsLoopback
if (
  ($domainUri.Scheme -ne 'https' -and -not $localTestCdn) -or
  $domainUri.UserInfo -or
  $domainUri.AbsolutePath -ne '/' -or
  $domainUri.Query -or
  $domainUri.Fragment) { throw 'release_cdn_domain_invalid' }
$domain = $domainUri.GetLeftPart([UriPartial]::Authority)
$serverUri = $null
if (-not [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$serverUri) -or
  $serverUri.UserInfo -or $serverUri.Query -or $serverUri.Fragment -or
  $serverUri.AbsolutePath -ne '/' -or
  ($serverUri.Scheme -ne 'https' -and -not ($TargetEnvironment -eq 'test' -and $serverUri.Scheme -eq 'http' -and $serverUri.IsLoopback))) {
  throw 'release_server_url_invalid'
}
if ($TargetEnvironment -eq 'test' -and
  ($serverUri.Scheme -ne 'http' -or -not $serverUri.IsLoopback)) {
  throw 'release_test_server_must_be_loopback'
}
$serverUrlValue = $serverUri.GetLeftPart([UriPartial]::Authority)
$ReleaseId = if ($ReleaseId) { $ReleaseId } else { "bridge-$ReleaseVersion-$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd.HHmmss'))" }
$outputRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repo "bridge\release-artifacts\$ReleaseId" }
if (Test-Path -LiteralPath $outputRoot) { throw 'release_output_exists' }
if ($DryRun) {
  [pscustomobject]@{ ok=$true; operation='build'; dry_run=$true; environment=$TargetEnvironment; release_id=$ReleaseId; git_branch=$branch; git_commit=$commit; source_dirty=$dirty; server_url=$serverUrlValue; output=$outputRoot } | ConvertTo-Json
  exit 0
}
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) "aurum-release-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null
$buildSucceeded = $false
try {
  $cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
  $cargo = if ($null -ne $cargoCommand) {
    $cargoCommand.Source
  } else {
    Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
  }
  if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
    throw 'release_native_cargo_missing'
  }
  $nativeRoot = Join-Path $repo 'bridge\native'
  Push-Location $nativeRoot
  try {
    & $cargo build --locked --release -p liangjian-bridge-ui -p liangjian-bridge-core `
      -p liangjian-bridge-launcher
    if ($LASTEXITCODE -ne 0) { throw 'release_native_build_failed' }
  }
  finally {
    Pop-Location
  }

  $nativeRelease = Join-Path $nativeRoot 'target\x86_64-pc-windows-msvc\release'
  $nativeUi = Join-Path $nativeRelease 'liangjian-bridge-ui.exe'
  $nativeCore = Join-Path $nativeRelease 'liangjian-bridge-core.exe'
  $nativeLauncher = Join-Path $nativeRelease 'liangjian-bridge-launcher.exe'
  foreach ($nativeExecutable in @($nativeUi, $nativeCore, $nativeLauncher)) {
    if (-not (Test-Path -LiteralPath $nativeExecutable -PathType Leaf)) {
      throw 'release_native_artifact_missing'
    }
    $nativeProductVersion = (Get-Item -LiteralPath $nativeExecutable).VersionInfo.ProductVersion
    $nativeVersion = $null
    if (-not [Version]::TryParse(($nativeProductVersion -split '[+-]')[0], [ref]$nativeVersion) -or
      $nativeVersion.Major -ne $parsedVersion.Major -or
      $nativeVersion.Minor -ne $parsedVersion.Minor -or
      $nativeVersion.Build -ne $parsedVersion.Build) {
      throw 'release_core_version_mismatch'
    }
  }

  $core = Join-Path $work 'core'
  New-Item -ItemType Directory -Path $core -Force | Out-Null
  Copy-Item -LiteralPath $nativeUi -Destination (Join-Path $core 'AURUMBridge.exe')
  Copy-Item -LiteralPath $nativeCore -Destination (Join-Path $core 'AURUMBridge.Core.exe')
  $launcherArtifact = Join-Path $core 'launcher\AURUMBridge.Launcher.exe'
  New-Item -ItemType Directory -Path (Split-Path $launcherArtifact -Parent) -Force | Out-Null
  Copy-Item -LiteralPath $nativeLauncher -Destination $launcherArtifact
  $runtimeTarget = Join-Path $core 'runtime\python'
  New-Item -ItemType Directory -Path $runtimeTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $pythonRoot '*') -Destination $runtimeTarget -Recurse -Force
  $prunedRuntimeExtensions = @('.pdb','.d','.rlib','.lib','.exp','.obj','.ilk','.map')
  $prunedRuntimeArtifacts = @(Get-ChildItem -LiteralPath $runtimeTarget -Recurse -File -Force | Where-Object {
    $prunedRuntimeExtensions -contains $_.Extension.ToLowerInvariant()
  })
  $prunedRuntimeBytes = ($prunedRuntimeArtifacts | Measure-Object Length -Sum).Sum
  foreach ($artifact in $prunedRuntimeArtifacts) {
    Remove-Item -LiteralPath $artifact.FullName -Force
  }
  Write-Utf8NoBom -Path (Join-Path $core 'server-endpoints.json') -Content (([ordered]@{
    schema_version=1
    server_url=$serverUrlValue
  }) | ConvertTo-Json)
  $moduleRoot = Join-Path $work 'modules'
  New-Item -ItemType Directory -Path (Join-Path $moduleRoot 'adapter.mt5.python') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $moduleRoot 'adapter.mt4') -Force | Out-Null
  $nativeMt5Worker = Join-Path $nativeRoot 'workers\mt5'
  Copy-Item -LiteralPath (Join-Path $nativeMt5Worker 'worker.py') `
    -Destination (Join-Path $moduleRoot 'adapter.mt5.python\worker.py')
  Copy-Item -LiteralPath (Join-Path $nativeMt5Worker 'trade.py') `
    -Destination (Join-Path $moduleRoot 'adapter.mt5.python\trade.py')
  $mt4Target = Join-Path $moduleRoot 'adapter.mt4'
  if ($MetaEditorExe -and (Test-Path -LiteralPath $MetaEditorExe -PathType Leaf)) {
    $mq4 = Join-Path $mt4Target 'AURUMBridgeEA.mq4'
    $compileLog = Join-Path $mt4Target 'compile.log'
    Copy-Item -LiteralPath (Join-Path $repo 'bridge\adapters\mt4-ea\AURUMBridgeEA.mq4') -Destination $mq4
    $compileArgument = "/compile:`"$mq4`""
    $logArgument = "/log:`"$compileLog`""
    $null = Start-Process -FilePath $MetaEditorExe -ArgumentList @($compileArgument,$logArgument) -Wait -PassThru -WindowStyle Hidden
    if (-not (Test-Path -LiteralPath (Join-Path $mt4Target 'AURUMBridgeEA.ex4') -PathType Leaf) -or -not (Test-Path -LiteralPath $compileLog -PathType Leaf)) { throw 'release_mt4_compile_failed' }
    $compileText = Get-Content -LiteralPath $compileLog -Raw -ErrorAction Stop
    if ($compileText -notmatch 'Result:\s*0 errors,\s*0 warnings') { throw 'release_mt4_compile_failed' }
    Remove-Item -LiteralPath $mq4,$compileLog -Force
  } else {
    $committedEx4 = Join-Path $repo 'bridge\adapters\mt4-ea\AURUMBridgeEA.ex4'
    if (-not (Test-Path -LiteralPath $committedEx4 -PathType Leaf) -or (Get-Item -LiteralPath $committedEx4).Length -le 0) { throw 'release_mt4_artifact_missing' }
    Copy-Item -LiteralPath $committedEx4 -Destination (Join-Path $mt4Target 'AURUMBridgeEA.ex4')
  }
  $complianceWork = Join-Path $work 'compliance'
  & (Join-Path $PSScriptRoot 'generate-native-compliance.ps1') `
    -OutputDirectory $complianceWork `
    -CargoManifest (Join-Path $nativeRoot 'Cargo.toml') `
    -Target 'x86_64-pc-windows-msvc' `
    -NativeExecutable @($nativeUi,$nativeCore,$nativeLauncher) `
    -StagedDirectory @($core,(Join-Path $moduleRoot 'adapter.mt5.python'),$mt4Target) `
    -PythonRuntimeDirectory $runtimeTarget | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'release_native_compliance_failed' }
  $coreCompliance = Join-Path $core 'compliance'
  $outputCompliance = Join-Path $outputRoot 'compliance'
  Copy-Item -LiteralPath $complianceWork -Destination $coreCompliance -Recurse
  Copy-Item -LiteralPath $complianceWork -Destination $outputCompliance -Recurse
  Assert-NativeReleaseLayout `
    -CoreDirectory $core `
    -Mt5Directory (Join-Path $moduleRoot 'adapter.mt5.python') `
    -Mt4Directory $mt4Target `
    -LauncherPath $launcherArtifact
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $sources = [ordered]@{ 'core'=$core; 'adapter.mt5.python'=(Join-Path $moduleRoot 'adapter.mt5.python'); 'adapter.mt4'=(Join-Path $moduleRoot 'adapter.mt4') }
  $packages = @()
  foreach ($entry in $sources.GetEnumerator()) {
    $zip = Join-Path $outputRoot "$($entry.Key).zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($entry.Value, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath $zip).Length
    $key = "bridge/releases/$ReleaseVersion/$hash/$($entry.Key).zip"
    $packages += [ordered]@{ module_id=$entry.Key; version=$ReleaseVersion; url="$domain/$key"; size_bytes=$size; sha256=$hash; signature='' }
  }
  $now = [DateTimeOffset]::UtcNow
  $manifest = [ordered]@{
    schema_version=2; release_id=$ReleaseId; release_version=$ReleaseVersion
    generated_at_utc_msc=$now.ToUnixTimeMilliseconds(); published_at_utc_msc=$now.ToUnixTimeMilliseconds()
    expires_at_utc_msc=$now.AddDays($ExpiresInDays).ToUnixTimeMilliseconds(); priority=$Priority
    minimum_launcher_version=$MinimumLauncherVersion; minimum_idle_seconds=$MinimumIdleSeconds
    activation_deadline_utc_msc=$ActivationDeadlineUtcMsc; rollout_channel=$RolloutChannel; rollout_percentage=$RolloutPercentage
    packages=$packages; signature=''
  }
  $manifestPath = Join-Path $outputRoot 'manifest.unsigned.json'
  Write-Utf8NoBom -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 8)
  $buildResult = [pscustomobject]@{
    ok=$true; operation='build'; implementation='rust-native'
    release_id=$ReleaseId; release_notes=$ReleaseNotes
    git_branch=$branch; git_commit=$commit; source_dirty=$dirty
    server_url=$serverUrlValue; output=$outputRoot; manifest=$manifestPath
    python_runtime_pruning=[ordered]@{
      removed_file_count=$prunedRuntimeArtifacts.Count
      removed_bytes=[long]$prunedRuntimeBytes
    }
    launcher=[ordered]@{
      package_module='core'
      package_relative_path='launcher/AURUMBridge.Launcher.exe'
      size_bytes=(Get-Item -LiteralPath $launcherArtifact).Length
      sha256=(Get-FileHash -LiteralPath $launcherArtifact -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    compliance=[ordered]@{
      directory=$outputCompliance
      sbom=[ordered]@{
        path=(Join-Path $outputCompliance 'bridge-native.spdx.json')
        size_bytes=(Get-Item -LiteralPath (Join-Path $outputCompliance 'bridge-native.spdx.json')).Length
        sha256=(Get-FileHash -LiteralPath (Join-Path $outputCompliance 'bridge-native.spdx.json') -Algorithm SHA256).Hash.ToLowerInvariant()
      }
      licenses=[ordered]@{
        path=(Join-Path $outputCompliance 'THIRD-PARTY-LICENSES.txt')
        size_bytes=(Get-Item -LiteralPath (Join-Path $outputCompliance 'THIRD-PARTY-LICENSES.txt')).Length
        sha256=(Get-FileHash -LiteralPath (Join-Path $outputCompliance 'THIRD-PARTY-LICENSES.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
      }
      audit=[ordered]@{
        path=(Join-Path $outputCompliance 'native-dependency-audit.json')
        size_bytes=(Get-Item -LiteralPath (Join-Path $outputCompliance 'native-dependency-audit.json')).Length
        sha256=(Get-FileHash -LiteralPath (Join-Path $outputCompliance 'native-dependency-audit.json') -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
    packages=$packages
  }
  Write-Utf8NoBom -Path (Join-Path $outputRoot 'build-result.json') -Content ($buildResult | ConvertTo-Json -Depth 8)
  $buildSucceeded = $true
  Get-Content -LiteralPath (Join-Path $outputRoot 'build-result.json') -Raw
} finally {
  if ((Test-Path -LiteralPath $work) -and $work.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
  if (-not $buildSucceeded -and (Test-Path -LiteralPath $outputRoot)) {
    Remove-Item -LiteralPath $outputRoot -Recurse -Force
  }
}
