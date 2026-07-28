param(
  [Parameter(Mandatory=$true)][string]$ReleaseVersion,
  [Parameter(Mandatory=$true)][ValidateSet('normal','urgent')][string]$Priority,
  [Parameter(Mandatory=$true)][ValidateSet('internal','stable')][string]$RolloutChannel,
  [Parameter(Mandatory=$true)][ValidateRange(1,100)][int]$RolloutPercentage,
  [Parameter(Mandatory=$true)][string]$PythonRuntimeDirectory,
  [Parameter(Mandatory=$true)][string]$CdnDomain,
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
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dirty = [bool](git -C $repo status --porcelain)
if ($TargetEnvironment -eq 'production' -and $dirty) { throw 'release_production_worktree_dirty' }
$parsedVersion = $null
if (-not [Version]::TryParse($ReleaseVersion, [ref]$parsedVersion)) { throw 'release_version_invalid' }
if ($MinimumIdleSeconds -lt 30 -or $MinimumIdleSeconds -gt 3600) { throw 'release_minimum_idle_invalid' }
$pythonRoot = (Resolve-Path -LiteralPath $PythonRuntimeDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $pythonRoot 'python.exe') -PathType Leaf)) { throw 'release_python_runtime_invalid' }
if ((Test-Path -LiteralPath (Join-Path $pythonRoot 'pyvenv.cfg')) -or
  (Test-Path -LiteralPath (Join-Path (Split-Path $pythonRoot -Parent) 'pyvenv.cfg'))) { throw 'release_python_runtime_not_portable' }
if ($TargetEnvironment -eq 'production' -and (-not $MetaEditorExe -or -not (Test-Path -LiteralPath $MetaEditorExe -PathType Leaf))) { throw 'release_metaeditor_required' }
$domain = $CdnDomain.TrimEnd('/')
$domainUri = $null
if (-not [Uri]::TryCreate($domain, [UriKind]::Absolute, [ref]$domainUri) -or
  $domainUri.Scheme -ne 'https' -or
  $domainUri.UserInfo -or
  $domainUri.AbsolutePath -ne '/' -or
  $domainUri.Query -or
  $domainUri.Fragment) { throw 'release_cdn_domain_invalid' }
$domain = $domainUri.GetLeftPart([UriPartial]::Authority)
$ReleaseId = if ($ReleaseId) { $ReleaseId } else { "bridge-$ReleaseVersion-$([DateTimeOffset]::UtcNow.ToString('yyyyMMdd.HHmmss'))" }
$outputRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repo "bridge\release-artifacts\$ReleaseId" }
if (Test-Path -LiteralPath $outputRoot) { throw 'release_output_exists' }
if ($DryRun) {
  [pscustomobject]@{ ok=$true; operation='build'; dry_run=$true; environment=$TargetEnvironment; release_id=$ReleaseId; output=$outputRoot } | ConvertTo-Json
  exit 0
}
New-Item -ItemType Directory -Path $outputRoot | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) "aurum-release-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $dotnet = if ($env:AURUM_DOTNET_EXE) { $env:AURUM_DOTNET_EXE } elseif (Get-Command dotnet -ErrorAction SilentlyContinue) { 'dotnet' } else { Join-Path $env:USERPROFILE '.cache\aurum-dotnet\dotnet.exe' }
  $core = Join-Path $work 'core'
  & $dotnet publish (Join-Path $repo 'bridge\app\AurumBridge\AurumBridge.csproj') -c Release -r win-x64 --self-contained true -o $core
  if ($LASTEXITCODE -ne 0) { throw 'release_dotnet_publish_failed' }
  $runtimeTarget = Join-Path $core 'runtime\python'
  New-Item -ItemType Directory -Path $runtimeTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $pythonRoot '*') -Destination $runtimeTarget -Recurse -Force
  $moduleRoot = Join-Path $work 'modules'
  New-Item -ItemType Directory -Path (Join-Path $moduleRoot 'adapter.mt5.python') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $moduleRoot 'adapter.mt4') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'bridge\adapters\mt5-python\worker.py') -Destination (Join-Path $moduleRoot 'adapter.mt5.python\worker.py')
  $mt4Target = Join-Path $moduleRoot 'adapter.mt4'
  if ($MetaEditorExe -and (Test-Path -LiteralPath $MetaEditorExe -PathType Leaf)) {
    $mq4 = Join-Path $mt4Target 'AURUMBridgeEA.mq4'
    $compileLog = Join-Path $mt4Target 'compile.log'
    Copy-Item -LiteralPath (Join-Path $repo 'bridge\adapters\mt4-ea\AURUMBridgeEA.mq4') -Destination $mq4
    & $MetaEditorExe "/compile:$mq4" "/log:$compileLog"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $mt4Target 'AURUMBridgeEA.ex4') -PathType Leaf)) { throw 'release_mt4_compile_failed' }
    $compileText = Get-Content -LiteralPath $compileLog -Raw -ErrorAction Stop
    if ($compileText -notmatch 'Result:\s*0 errors,\s*0 warnings') { throw 'release_mt4_compile_failed' }
    Remove-Item -LiteralPath $mq4,$compileLog -Force
  } else {
    $committedEx4 = Join-Path $repo 'bridge\adapters\mt4-ea\AURUMBridgeEA.ex4'
    if (-not (Test-Path -LiteralPath $committedEx4 -PathType Leaf) -or (Get-Item -LiteralPath $committedEx4).Length -le 0) { throw 'release_mt4_artifact_missing' }
    Copy-Item -LiteralPath $committedEx4 -Destination (Join-Path $mt4Target 'AURUMBridgeEA.ex4')
  }
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
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
  [pscustomobject]@{ ok=$true; operation='build'; release_id=$ReleaseId; release_notes=$ReleaseNotes; output=$outputRoot; manifest=$manifestPath; packages=$packages } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputRoot 'build-result.json') -Encoding utf8NoBOM
  Get-Content -LiteralPath (Join-Path $outputRoot 'build-result.json') -Raw
} finally {
  if ((Test-Path -LiteralPath $work) -and $work.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
}
