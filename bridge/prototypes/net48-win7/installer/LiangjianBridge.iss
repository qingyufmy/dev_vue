#ifndef BridgeVersion
  #define BridgeVersion "4.0.0.0"
#endif
#ifndef PrototypeRoot
  #error PrototypeRoot must be provided by build-installer.ps1
#endif
#ifndef StagingRoot
  #error StagingRoot must be provided by build-installer.ps1
#endif
#ifndef InstallerOutputRoot
  #error InstallerOutputRoot must be provided by build-installer.ps1
#endif
#ifdef OfflineRuntime
  #ifndef OfflineRuntimePath
    #error OfflineRuntimePath is required for the offline installer
  #endif
  #define InstallerSuffix "offline"
#else
  #define InstallerSuffix "online"
#endif

[Setup]
AppId={{4B8EC40E-79A2-4C0A-96A0-C92DA2B9D490}
AppName=量见智桥 V4 原型
AppVersion={#BridgeVersion}
AppPublisher=量见
DefaultDirName={autopf}\Liangjian\BridgeV4Prototype
DefaultGroupName=量见智桥 V4 原型
OutputDir={#InstallerOutputRoot}
OutputBaseFilename=LiangjianBridge-V4-{#BridgeVersion}-{#InstallerSuffix}-setup
Compression=lzma2/normal
SolidCompression=yes
PrivilegesRequired=admin
MinVersion=6.1sp1
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
RestartIfNeededByRun=yes
UninstallDisplayIcon={app}\AURUMBridge.Launcher.exe
ArchitecturesInstallIn64BitMode=

[Files]
Source: "{#StagingRoot}\*"; DestDir: "{app}"; Excludes: "LiangjianBridge.AuthenticodeVerifier.exe"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StagingRoot}\LiangjianBridge.AuthenticodeVerifier.exe"; Flags: dontcopy noencryption
#ifdef OfflineRuntime
Source: "{#OfflineRuntimePath}"; DestName: "NDP48-x86-x64-AllOS-ENU.exe"; Flags: dontcopy noencryption
#endif

[Icons]
Name: "{group}\量见智桥 V4 原型"; Filename: "{app}\AURUMBridge.Launcher.exe"
Name: "{autodesktop}\量见智桥 V4 原型"; Filename: "{app}\AURUMBridge.Launcher.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Run]
Filename: "{app}\AURUMBridge.Launcher.exe"; Description: "启动量见智桥 V4 原型"; Flags: nowait postinstall skipifsilent

[Code]
const
  Net48MinimumRelease = 528040;
  Net48RegistryKey = 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full';
  Net48WebUrl = 'https://go.microsoft.com/fwlink/?LinkId=2085155';
  Net48WebFile = 'ndp48-web.exe';
  Net48WebSha256 = '0BBA3094588C4BFEC301939985222A20B340BF03431563DEC8B2B4478B06FFFA';
  Net48OfflineSha256 = '0A3A390C47E639D0F7FC65B21195FEE6B7F65B066F80F70C60FAB191D14B7E40';

function Net48Installed: Boolean;
var
  Release32: Cardinal;
  Release64: Cardinal;
begin
  Release32 := 0;
  Release64 := 0;
  RegQueryDWordValue(HKLM32, Net48RegistryKey, 'Release', Release32);
  if IsWin64 then
    RegQueryDWordValue(HKLM64, Net48RegistryKey, 'Release', Release64);
  Result := (Release32 >= Net48MinimumRelease) or (Release64 >= Net48MinimumRelease);
end;

function ResumeSetupPath: String;
begin
  Result := ExpandConstant('{commonappdata}\Liangjian\BridgeV4\installer-resume\LiangjianBridgeSetup.exe');
end;

function StageResumeSetup: Boolean;
var
  ResumeDirectory: String;
begin
  ResumeDirectory := ExtractFileDir(ResumeSetupPath);
  Result := ForceDirectories(ResumeDirectory) and CopyFile(ExpandConstant('{srcexe}'), ResumeSetupPath, False);
end;

function AcquireNet48Runtime: String;
begin
#ifdef OfflineRuntime
  ExtractTemporaryFile('NDP48-x86-x64-AllOS-ENU.exe');
  Result := ExpandConstant('{tmp}\NDP48-x86-x64-AllOS-ENU.exe');
  if CompareText(GetSHA256OfFile(Result), Net48OfflineSha256) <> 0 then
    RaiseException('离线 .NET Framework 4.8 Runtime 的 SHA-256 校验失败。');
#else
  DownloadTemporaryFile(Net48WebUrl, Net48WebFile, Net48WebSha256, nil);
  Result := ExpandConstant('{tmp}\' + Net48WebFile);
#endif
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  RuntimePath: String;
  VerifierPath: String;
  ResultCode: Integer;
begin
  Result := '';
  if Net48Installed then
    exit;

  try
    RuntimePath := AcquireNet48Runtime;
  except
    Result := '无法安全取得 .NET Framework 4.8 Runtime：' + GetExceptionMessage;
    exit;
  end;

  ExtractTemporaryFile('LiangjianBridge.AuthenticodeVerifier.exe');
  VerifierPath := ExpandConstant('{tmp}\LiangjianBridge.AuthenticodeVerifier.exe');
  if (not Exec(VerifierPath, '"' + RuntimePath + '"', ExpandConstant('{tmp}'), SW_SHOWNORMAL,
      ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    Result := '.NET Framework 4.8 Runtime 的 Microsoft 签名或产品身份校验失败。';
    exit;
  end;

  if not Exec(RuntimePath, '/q /norestart', ExtractFileDir(RuntimePath), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
  begin
    Result := '无法启动 .NET Framework 4.8 安装程序：' + SysErrorMessage(ResultCode);
    exit;
  end;

  if (ResultCode = 3010) or (ResultCode = 1641) then
  begin
    if not StageResumeSetup then
    begin
      Result := '.NET Framework 4.8 需要重启，但无法安全保存续装程序。请重启后重新运行本安装包。';
      exit;
    end;
    if not RegWriteStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
      'LiangjianBridgeV4SetupResume', '"' + ResumeSetupPath + '" /RESUME /SP-') then
    begin
      Result := '.NET Framework 4.8 需要重启，但无法登记续装任务。请重启后重新运行本安装包。';
      exit;
    end;
    NeedsRestart := True;
    Result := '.NET Framework 4.8 已安装并需要重启。重启后将自动继续安装量见智桥。';
    exit;
  end;

  if ResultCode <> 0 then
  begin
    Result := '.NET Framework 4.8 安装失败，退出码：' + IntToStr(ResultCode) + '。';
    exit;
  end;
  if not Net48Installed then
    Result := '.NET Framework 4.8 安装程序已退出，但运行时仍未满足要求。';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssDone then
  begin
    RegDeleteValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce', 'LiangjianBridgeV4SetupResume');
    DeleteFile(ResumeSetupPath);
  end;
end;
