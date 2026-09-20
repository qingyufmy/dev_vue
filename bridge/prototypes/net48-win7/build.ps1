param(
    [ValidateSet('x86', 'x64')]
    [string]$Platform = 'x86',
    [ValidateSet('artifacts', 'artifacts-review')]
    [string]$BuildDirectoryName = 'artifacts',
    [string]$ClientConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$artifactsRoot = Join-Path $prototypeRoot $BuildDirectoryName
$packagesRoot = Join-Path $prototypeRoot '.packages'
if ($ClientConfigPath) {
    & (Join-Path $prototypeRoot 'prepare-client-config.ps1') -ClientConfigPath $ClientConfigPath | Out-Host
}
$coreOutput = Join-Path $artifactsRoot 'LiangjianBridge.Core.dll'
$appOutput = Join-Path $artifactsRoot 'LiangjianBridge.exe'
$launcherOutput = Join-Path $artifactsRoot 'LiangjianBridge.Launcher.exe'
$testsOutput = Join-Path $artifactsRoot 'LiangjianBridge.SmokeTests.exe'
$wssProbeOutput = Join-Path $artifactsRoot 'LiangjianBridge.WssProbe.exe'
$terminalProbeOutput = Join-Path $artifactsRoot 'LiangjianBridge.TerminalProbe.exe'
$signatureVerifierOutput = Join-Path $artifactsRoot 'LiangjianBridge.AuthenticodeVerifier.exe'
$transitionLauncherOutput = Join-Path $artifactsRoot 'AURUMBridge.Launcher.exe'
$updateFixtureOutput = Join-Path $artifactsRoot 'LiangjianBridge.UpdateFixture.exe'
$signedStageFixtureOutput = Join-Path $artifactsRoot 'LiangjianBridge.SignedStageFixture.exe'
$frameworkRoot = if ($Platform -eq 'x86') {
    Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
} else {
    Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
}
$compiler = Join-Path $frameworkRoot 'csc.exe'
$sqliteVersion = '1.0.119'
$sqlitePackageHash = 'F5F86B80729323890DA590A8C7BA7957F04E2735E583D075220D1521745E9F4C'
$sqlitePackageRoot = Join-Path $packagesRoot "stub.system.data.sqlite.core.netframework.$sqliteVersion"
$sqliteManaged = Join-Path $sqlitePackageRoot 'lib\net46\System.Data.SQLite.dll'
$sqliteNative = Join-Path $sqlitePackageRoot "build\net46\$Platform\SQLite.Interop.dll"

if (-not (Test-Path -LiteralPath $compiler)) {
    throw "bridge_csharp_compiler_missing: $compiler"
}

if (-not (Test-Path -LiteralPath $sqliteManaged)) {
    New-Item -ItemType Directory -Path $packagesRoot -Force | Out-Null
    $packageFile = Join-Path $packagesRoot "stub.system.data.sqlite.core.netframework.$sqliteVersion.nupkg"
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/stub.system.data.sqlite.core.netframework/$sqliteVersion/stub.system.data.sqlite.core.netframework.$sqliteVersion.nupkg" -OutFile $packageFile
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $packageFile).Hash
    if (-not [string]::Equals($actualHash, $sqlitePackageHash, [StringComparison]::OrdinalIgnoreCase)) {
        throw "bridge_sqlite_package_hash_invalid: $actualHash"
    }
    $packageZip = [IO.Path]::ChangeExtension($packageFile, '.zip')
    Copy-Item -LiteralPath $packageFile -Destination $packageZip -Force
    Expand-Archive -LiteralPath $packageZip -DestinationPath $sqlitePackageRoot -Force
}
if (-not (Test-Path -LiteralPath $sqliteManaged) -or -not (Test-Path -LiteralPath $sqliteNative)) {
    throw 'bridge_sqlite_package_incomplete'
}

New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null
$resolvedPrototypeRoot = [IO.Path]::GetFullPath($prototypeRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedArtifactsRoot = [IO.Path]::GetFullPath($artifactsRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$expectedArtifactsRoot = Join-Path $resolvedPrototypeRoot $BuildDirectoryName
if (-not [string]::Equals($resolvedArtifactsRoot, $expectedArtifactsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "bridge_artifacts_root_invalid: $resolvedArtifactsRoot"
}
# An archive/live worker can still execute from artifacts-review even when the GUI is elsewhere.
# Check before deleting any output, otherwise a failed cleanup leaves a partial Python runtime.
$activeBuildProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolvedArtifactsRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}
if ($activeBuildProcesses) { throw 'bridge_build_output_in_use' }
$buildOutputs = @(
    $coreOutput,
    $appOutput,
    $launcherOutput,
    $testsOutput,
    $wssProbeOutput,
    $terminalProbeOutput,
    $signatureVerifierOutput,
    $transitionLauncherOutput,
    $updateFixtureOutput,
    $signedStageFixtureOutput,
    (Join-Path $resolvedArtifactsRoot 'x86'),
    (Join-Path $resolvedArtifactsRoot 'x64')
    (Join-Path $resolvedArtifactsRoot 'runtime')
    (Join-Path $resolvedArtifactsRoot 'workers')
    (Join-Path $resolvedArtifactsRoot 'bridge-client.json')
)
foreach ($buildOutput in $buildOutputs) {
    if (Test-Path -LiteralPath $buildOutput) {
        Remove-Item -LiteralPath $buildOutput -Recurse -Force
    }
}

$common = @('/nologo', '/checked+', '/warn:4', '/warnaserror+', "/platform:$Platform", '/optimize+')
$references = @(
    "/reference:$frameworkRoot\System.dll",
    "/reference:$frameworkRoot\System.Core.dll",
    "/reference:$frameworkRoot\System.Data.dll",
    "/reference:$frameworkRoot\System.IO.Compression.dll",
    "/reference:$frameworkRoot\System.IO.Compression.FileSystem.dll",
    "/reference:$frameworkRoot\System.Security.dll",
    "/reference:$frameworkRoot\System.Web.Extensions.dll",
    "/reference:$sqliteManaged"
)
$coreSources = Get-ChildItem -LiteralPath (Join-Path $prototypeRoot 'src\LiangjianBridge.Core') -Filter '*.cs' -Recurse | ForEach-Object FullName

& $compiler @common @references /target:library "/out:$coreOutput" @coreSources
if ($LASTEXITCODE -ne 0) { throw 'bridge_core_build_failed' }
Copy-Item -LiteralPath $sqliteManaged -Destination (Join-Path $artifactsRoot 'System.Data.SQLite.dll') -Force
$nativeOutput = Join-Path $artifactsRoot $Platform
New-Item -ItemType Directory -Path $nativeOutput -Force | Out-Null
Copy-Item -LiteralPath $sqliteNative -Destination (Join-Path $nativeOutput 'SQLite.Interop.dll') -Force

$applicationIcon = Join-Path $prototypeRoot '..\..\assets\liangjian-bridge.ico'
$appSources = Get-ChildItem -LiteralPath (Join-Path $prototypeRoot 'src\LiangjianBridge') -Filter '*.cs' -Recurse | ForEach-Object FullName
& $compiler @common @references "/reference:$coreOutput" "/reference:$frameworkRoot\System.Drawing.dll" "/reference:$frameworkRoot\System.Windows.Forms.dll" /target:winexe "/win32icon:$applicationIcon" "/resource:$applicationIcon,LiangjianBridge.ico" "/out:$appOutput" @appSources
if ($LASTEXITCODE -ne 0) { throw 'bridge_app_build_failed' }

$launcherSources = Get-ChildItem -LiteralPath (Join-Path $prototypeRoot 'src\LiangjianBridge.Launcher') -Filter '*.cs' | ForEach-Object FullName
& $compiler @common @references /target:winexe "/win32icon:$applicationIcon" "/out:$launcherOutput" @launcherSources
if ($LASTEXITCODE -ne 0) { throw 'bridge_launcher_build_failed' }

$smokeSources = Get-ChildItem -LiteralPath (Join-Path $prototypeRoot 'tests\LiangjianBridge.SmokeTests') -Filter '*.cs' | ForEach-Object FullName
& $compiler @common @references "/reference:$coreOutput" /target:exe "/out:$testsOutput" @smokeSources (Join-Path $prototypeRoot 'src\LiangjianBridge.Launcher\VersionPointer.cs') (Join-Path $prototypeRoot 'src\LiangjianBridge.Launcher\LauncherActivation.cs') (Join-Path $prototypeRoot 'src\LiangjianBridge.Launcher\ActivationStatusWriter.cs')
if ($LASTEXITCODE -ne 0) { throw 'bridge_tests_build_failed' }

& $compiler @common @references "/reference:$coreOutput" /target:exe "/out:$wssProbeOutput" (Join-Path $prototypeRoot 'tests\LiangjianBridge.WssProbe\Program.cs')
if ($LASTEXITCODE -ne 0) { throw 'bridge_wss_probe_build_failed' }

& $compiler @common @references "/reference:$coreOutput" /target:exe "/out:$terminalProbeOutput" (Join-Path $prototypeRoot 'tests\LiangjianBridge.TerminalProbe\Program.cs')
if ($LASTEXITCODE -ne 0) { throw 'bridge_terminal_probe_build_failed' }

& $compiler @common @references "/reference:$coreOutput" /target:winexe "/out:$updateFixtureOutput" (Join-Path $prototypeRoot 'tests\LiangjianBridge.UpdateFixture\Program.cs')
if ($LASTEXITCODE -ne 0) { throw 'bridge_update_fixture_build_failed' }

& $compiler @common @references "/reference:$coreOutput" /target:exe "/out:$signedStageFixtureOutput" (Join-Path $prototypeRoot 'tests\LiangjianBridge.SignedStageFixture\Program.cs')
if ($LASTEXITCODE -ne 0) { throw 'bridge_signed_stage_fixture_build_failed' }

Write-Host "Built Bridge V4 prototype ($Platform): $artifactsRoot"
if ($ClientConfigPath) {
    & (Join-Path $prototypeRoot 'prepare-client-config.ps1') -ClientConfigPath $ClientConfigPath -OutputRoot $artifactsRoot | Out-Host
}

$runtimeOutput = Join-Path $artifactsRoot 'runtime\python'
& (Join-Path $prototypeRoot 'prepare-runtime.ps1') -OutputRoot $runtimeOutput | Out-Host
$workerOutput = Join-Path $artifactsRoot 'workers\mt5'
New-Item -ItemType Directory -Path $workerOutput -Force | Out-Null
foreach ($module in @('worker.py', 'trade.py', 'order_completion.py')) {
    Copy-Item -LiteralPath (Join-Path $prototypeRoot "..\..\native\workers\mt5\$module") -Destination (Join-Path $workerOutput $module)
}
$workerVerification = Join-Path $runtimeOutput 'verify_worker.py'
Set-Content -LiteralPath $workerVerification -Encoding ASCII -Value 'import sys, runpy; runpy.run_path(sys.argv[1], run_name="bridge_import_check")'
& (Join-Path $runtimeOutput 'python.exe') -I $workerVerification (Join-Path $workerOutput 'worker.py')
if ($LASTEXITCODE -ne 0) { throw 'bridge_worker_python38_import_failed' }
& (Join-Path $prototypeRoot 'prepare-mt4-adapter.ps1') -OutputRoot (Join-Path $artifactsRoot 'adapters\mt4') | Out-Host
& (Join-Path $prototypeRoot 'prepare-mt4-adapter.ps1') -OutputRoot (Join-Path $artifactsRoot 'adapters\mt4') -VerifyOnly | Out-Host

if ($Platform -eq 'x86') {
    $vcVars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat'
    $verifierSource = Join-Path $prototypeRoot 'src\LiangjianBridge.AuthenticodeVerifier\main.cpp'
    if (-not (Test-Path -LiteralPath $vcVars)) {
        throw "bridge_cpp_build_tools_missing: $vcVars"
    }
    $verifierObject = Join-Path $artifactsRoot 'LiangjianBridge.AuthenticodeVerifier.obj'
    $compileVerifier = 'call "{0}" x86 >nul && cl.exe /nologo /W4 /WX /O2 /MT /DUNICODE /D_UNICODE /EHsc /Fo"{1}" "{2}" /link /OUT:"{3}" wintrust.lib crypt32.lib version.lib' -f $vcVars, $verifierObject, $verifierSource, $signatureVerifierOutput
    & cmd.exe /d /s /c $compileVerifier
    if ($LASTEXITCODE -ne 0) { throw 'bridge_signature_verifier_build_failed' }

    $transitionSourceRoot = Join-Path $prototypeRoot 'src\LiangjianBridge.TransitionLauncher'
    $transitionSource = Join-Path $transitionSourceRoot 'main.cpp'
    $transitionResourceSource = Join-Path $transitionSourceRoot 'version.rc'
    $transitionObject = Join-Path $artifactsRoot 'AURUMBridge.Launcher.obj'
    $transitionResource = Join-Path $artifactsRoot 'AURUMBridge.Launcher.res'
    $compileTransition = 'call "{0}" x86 >nul && rc.exe /nologo /c65001 /fo"{1}" "{2}" && cl.exe /nologo /utf-8 /W4 /WX /O2 /MT /DUNICODE /D_UNICODE /EHsc /Fo"{3}" "{4}" "{1}" /link /SUBSYSTEM:WINDOWS,6.01 /OUT:"{5}" advapi32.lib bcrypt.lib shell32.lib user32.lib version.lib' -f $vcVars, $transitionResource, $transitionResourceSource, $transitionObject, $transitionSource, $transitionLauncherOutput
    & cmd.exe /d /s /c $compileTransition
    if ($LASTEXITCODE -ne 0) { throw 'bridge_transition_launcher_build_failed' }
}
