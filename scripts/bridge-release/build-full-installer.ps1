param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
  [Parameter(Mandatory=$true)][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [string]$ManifestPath,
  [string]$LauncherVersion = '1.0.0',
  [ValidateSet('test','production')][string]$TargetEnvironment = 'test',
  [ValidateRange(1,3650)][int]$MinimumOfflineValidityDays = 90,
  [string]$TestLoopbackServerUrl = 'http://127.0.0.1:3000',
  [string]$TestRehearsalInstallRoot,
  [string]$InnoCompiler,
  [string]$AuthenticodeCertificateThumbprint = $env:AURUM_AUTHENTICODE_CERT_THUMBPRINT,
  [string]$TimestampServer = 'http://timestamp.digicert.com',
  [switch]$AllowUnsignedInstaller,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Resolve-InnoCompiler([string]$ConfiguredPath) {
  $candidates = @($ConfiguredPath, (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source)
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Escape-Inno([string]$Value) {
  return $Value.Replace('"', '""')
}

function Escape-PascalString([string]$Value) {
  return $Value.Replace("'", "''")
}

function ConvertFrom-CodePoints([int[]]$CodePoints) {
  return -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Get-CodeSigningCertificate([string]$Thumbprint) {
  $normalized = ($Thumbprint -replace '[^a-fA-F0-9]', '').ToUpperInvariant()
  return Get-ChildItem Cert:\CurrentUser\My | Where-Object {
    $_.Thumbprint -eq $normalized -and $_.HasPrivateKey -and
    $_.EnhancedKeyUsageList.ObjectId.Value -contains '1.3.6.1.5.5.7.3.3'
  } | Select-Object -First 1
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$publicKeyPath = (Resolve-Path -LiteralPath $PublicKey).Path
$manifestFile = if ($ManifestPath) {
  (Resolve-Path -LiteralPath $ManifestPath).Path
} else {
  (Resolve-Path -LiteralPath (Join-Path $releaseRoot 'manifest.signed.json')).Path
}
if (Test-Path -LiteralPath $output) { throw 'full_installer_output_exists' }
$serverUri = $null
$localTestServer = $TargetEnvironment -eq 'test' -and
  [Uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$serverUri) -and
  $serverUri.Scheme -eq 'http' -and $serverUri.IsLoopback
if (-not $serverUri -or $serverUri.UserInfo -or $serverUri.Query -or
  $serverUri.Fragment -or $serverUri.AbsolutePath -ne '/' -or
  ($TargetEnvironment -eq 'test' -and -not $localTestServer) -or
  ($TargetEnvironment -eq 'production' -and $serverUri.Scheme -ne 'https')) {
  throw 'full_installer_server_url_invalid'
}
$serverUrlValue = $serverUri.GetLeftPart([UriPartial]::Authority)
$rehearsalInstallRoot = $null
if ($TestRehearsalInstallRoot) {
  if ($TargetEnvironment -ne 'test') { throw 'full_installer_rehearsal_not_allowed' }
  $rehearsalInstallRoot = [IO.Path]::GetFullPath($TestRehearsalInstallRoot)
  $defaultInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'AURUM\LiangjianBridge'))
  if ($rehearsalInstallRoot -eq $defaultInstallRoot) { throw 'full_installer_rehearsal_not_allowed' }
}

$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$requiredModules = @('adapter.mt4','adapter.mt5.python','core')
$actualModules = @($manifest.packages | ForEach-Object { [string]$_.module_id } | Sort-Object)
$minimumExpiry = [DateTimeOffset]::UtcNow.AddDays($MinimumOfflineValidityDays).ToUnixTimeMilliseconds()
$parsedReleaseVersion = $null
if ($manifest.schema_version -ne 2 -or
  -not [Version]::TryParse([string]$manifest.release_version, [ref]$parsedReleaseVersion) -or
  [string]::IsNullOrWhiteSpace([string]$manifest.signature) -or
  $manifest.priority -ne 'normal' -or
  $null -ne $manifest.activation_deadline_utc_msc -or
  $manifest.rollout_channel -ne 'stable' -or
  [int]$manifest.rollout_percentage -ne 100 -or
  [long]$manifest.expires_at_utc_msc -lt $minimumExpiry -or
  (Compare-Object $requiredModules $actualModules)) {
  throw 'full_installer_manifest_invalid'
}

$packageFiles = [ordered]@{}
foreach ($package in $manifest.packages) {
  $moduleId = [string]$package.module_id
  if ([string]$package.version -ne [string]$manifest.release_version -or
    [string]::IsNullOrWhiteSpace([string]$package.signature)) {
    throw 'full_installer_manifest_invalid'
  }
  $fileName = switch ($moduleId) {
    'core' { 'core.zip' }
    'adapter.mt5.python' { 'adapter.mt5.python.zip' }
    'adapter.mt4' { 'adapter.mt4.zip' }
    default { throw 'full_installer_manifest_invalid' }
  }
  $path = Join-Path $releaseRoot $fileName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw 'full_installer_package_missing'
  }
  $file = Get-Item -LiteralPath $path
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($file.Length -ne [long]$package.size_bytes -or
    $hash -ne ([string]$package.sha256).ToLowerInvariant()) {
    throw 'full_installer_package_integrity_failed'
  }
  $packageFiles[$moduleId] = $path
}

$inno = Resolve-InnoCompiler $InnoCompiler
if ($DryRun) {
  [pscustomobject]@{
    ok=$true; operation='build-full-installer'; dry_run=$true
    environment=$TargetEnvironment; output=$output
    release_id=[string]$manifest.release_id
    release_version=[string]$manifest.release_version
    manifest=$manifestFile; inno_compiler=$inno
    build_ready=[bool]$inno
    package_size_bytes=($manifest.packages | Measure-Object size_bytes -Sum).Sum
    minimum_offline_validity_days=$MinimumOfflineValidityDays
    rehearsal_install_root=$rehearsalInstallRoot
  } | ConvertTo-Json
  exit 0
}
if (-not $inno) { throw 'full_installer_inno_compiler_missing' }

$work = Join-Path ([IO.Path]::GetTempPath()) "aurum-full-installer-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $work | Out-Null
New-Item -ItemType Directory -Path $output | Out-Null
$succeeded = $false
try {
  $installerBackendOutput = Join-Path $work 'installer-backend'
  $installerBackendArguments = @{
    OutputDirectory = $installerBackendOutput
    PublicKey = $publicKeyPath
    LauncherVersion = $LauncherVersion
    TargetEnvironment = $TargetEnvironment
  }
  & (Join-Path $PSScriptRoot 'build-native-installer-backend.ps1') @installerBackendArguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'full_installer_backend_build_failed' }

  $installerBackend = Join-Path $installerBackendOutput 'LiangjianBridgeInstallBackend.exe'
  $icon = (Resolve-Path -LiteralPath (Join-Path $repo 'bridge\assets\liangjian-bridge.ico')).Path
  $innoScript = Join-Path $work 'LiangjianBridgeSetup.iss'
  $installArgumentCode = if ($rehearsalInstallRoot) {
    "  Arguments := '--offline-bundle-root `"' + ExpandConstant('{tmp}') +`r`n" +
      "    '`" --rehearsal-install-root `"$(Escape-PascalString $rehearsalInstallRoot)`" --rehearsal-result `"' +`r`n" +
      "    ExpandConstant('{tmp}\install-result.json') + '`"';"
  } else {
    "  Arguments := '--offline-bundle-root `"' + ExpandConstant('{tmp}') +`r`n" +
      "    '`" --install-result `"' + ExpandConstant('{tmp}\install-result.json') + '`"';"
  }
  $productName = ConvertFrom-CodePoints @(0x91CF,0x89C1,0x667A,0x6865)
  $runSection = if ($rehearsalInstallRoot) { '' } else {
@"
[Run]
Filename: "{localappdata}\AURUM\LiangjianBridge\AURUMBridge.Launcher.exe"; Description: "{cm:LaunchProgram,$(Escape-Inno $productName)}"; Flags: nowait postinstall skipifsilent
"@
  }
  $iconSection = if ($rehearsalInstallRoot) { '' } else {
@"
[Icons]
Name: "{autodesktop}\$(Escape-Inno $productName)"; Filename: "{localappdata}\AURUM\LiangjianBridge\AURUMBridge.Launcher.exe"; WorkingDir: "{localappdata}\AURUM\LiangjianBridge"
Name: "{userprograms}\$(Escape-Inno $productName)"; Filename: "{localappdata}\AURUM\LiangjianBridge\AURUMBridge.Launcher.exe"; WorkingDir: "{localappdata}\AURUM\LiangjianBridge"
"@
  }
  $publisherName = ConvertFrom-CodePoints @(0x91CF,0x89C1)
  $installFailedMessage = ConvertFrom-CodePoints @(
    0x91CF,0x89C1,0x667A,0x6865,0x6838,0x5FC3,0x7EC4,0x4EF6,
    0x5B89,0x88C5,0x5931,0x8D25,0x3002,0x8BF7,0x9000,0x51FA,
    0x6B63,0x5728,0x8FD0,0x884C,0x7684,0x91CF,0x89C1,0x667A,
    0x6865,0x540E,0x91CD,0x8BD5,0xFF1B,0x5982,0x4ECD,0x5931,
    0x8D25,0xFF0C,0x8BF7,0x8054,0x7CFB,0x7BA1,0x7406,0x5458,
    0x3002
  )
  $innoText = @"
#define MyAppName "$(Escape-Inno $productName)"
#define MyAppVersion "$(Escape-Inno ([string]$manifest.release_version))"
#define MyAppPublisher "$(Escape-Inno $publisherName)"
#define MyAppURL "$(Escape-Inno $serverUrlValue)"

[Setup]
AppId={{AURUM-LiangjianBridge-V3}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\AURUM\LiangjianBridge
DisableDirPage=yes
DefaultGroupName={#MyAppName}
OutputDir=$(Escape-Inno $output)
OutputBaseFilename=LiangjianBridgeSetup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=$(Escape-Inno $icon)
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[CustomMessages]
chinesesimplified.InstallFailed=$(Escape-Inno $installFailedMessage)

[Files]
Source: "$(Escape-Inno $installerBackend)"; Flags: dontcopy
Source: "$(Escape-Inno $manifestFile)"; DestName: "manifest.signed.json"; Flags: dontcopy
Source: "$(Escape-Inno $($packageFiles['core']))"; DestName: "core.zip"; Flags: dontcopy
Source: "$(Escape-Inno $($packageFiles['adapter.mt5.python']))"; DestName: "adapter.mt5.python.zip"; Flags: dontcopy
Source: "$(Escape-Inno $($packageFiles['adapter.mt4']))"; DestName: "adapter.mt4.zip"; Flags: dontcopy

$runSection
$iconSection

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Arguments: String;
begin
  if CurStep <> ssInstall then
    exit;
  ExtractTemporaryFile('LiangjianBridgeInstallBackend.exe');
  ExtractTemporaryFile('manifest.signed.json');
  ExtractTemporaryFile('core.zip');
  ExtractTemporaryFile('adapter.mt5.python.zip');
  ExtractTemporaryFile('adapter.mt4.zip');
$installArgumentCode
  if (not Exec(ExpandConstant('{tmp}\LiangjianBridgeInstallBackend.exe'), Arguments,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    RaiseException(CustomMessage('InstallFailed'));
end;
"@
  [IO.File]::WriteAllText($innoScript, $innoText, [Text.UTF8Encoding]::new($true))
  & $inno $innoScript
  if ($LASTEXITCODE -ne 0) { throw 'full_installer_inno_build_failed' }
  $installer = Join-Path $output 'LiangjianBridgeSetup.exe'
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw 'full_installer_output_missing'
  }

  $authenticodeSigned = $false
  if ($AuthenticodeCertificateThumbprint) {
    $certificate = Get-CodeSigningCertificate $AuthenticodeCertificateThumbprint
    if (-not $certificate) { throw 'full_installer_authenticode_certificate_invalid' }
    $signature = Set-AuthenticodeSignature -FilePath $installer -Certificate $certificate `
      -TimestampServer $TimestampServer -HashAlgorithm SHA256
    if ($signature.Status -ne 'Valid') { throw 'full_installer_authenticode_signing_failed' }
    $authenticodeSigned = $true
  }
  if ($TargetEnvironment -eq 'production' -and -not $authenticodeSigned -and -not $AllowUnsignedInstaller) {
    throw 'full_installer_unsigned_confirmation_required'
  }

  $metadata = [ordered]@{
    schema_version=1
    installer_type='full-offline-v3'
    environment=$TargetEnvironment
    git_commit=(git -C $repo rev-parse HEAD)
    release_id=[string]$manifest.release_id
    release_version=[string]$manifest.release_version
    manifest_sha256=(Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
    embedded_package_size_bytes=($manifest.packages | Measure-Object size_bytes -Sum).Sum
    installer_backend='rust-native-v3'
    installer_backend_sha256=(Get-FileHash -LiteralPath $installerBackend -Algorithm SHA256).Hash.ToLowerInvariant()
    installer_size_bytes=(Get-Item -LiteralPath $installer).Length
    installer_sha256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticode_signed=$authenticodeSigned
    unsigned_installer_authorized=[bool]($TargetEnvironment -eq 'production' -and -not $authenticodeSigned -and $AllowUnsignedInstaller)
    minimum_offline_validity_days=$MinimumOfflineValidityDays
    rehearsal_install_root=$rehearsalInstallRoot
    generated_at_utc=(Get-Date).ToUniversalTime().ToString('o')
  }
  [IO.File]::WriteAllText(
    (Join-Path $output 'bootstrapper-metadata.json'),
    ($metadata | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false))
  $succeeded = $true
  [pscustomobject]@{
    ok=$true; operation='build-full-installer'; output=$output
    executable=$installer; release_version=$metadata.release_version
    size_bytes=$metadata.installer_size_bytes; sha256=$metadata.installer_sha256
    authenticode_signed=$authenticodeSigned
  } | ConvertTo-Json
}
finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  if (-not $succeeded -and (Test-Path -LiteralPath $output)) {
    Remove-Item -LiteralPath $output -Recurse -Force
  }
}
