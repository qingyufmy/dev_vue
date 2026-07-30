import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  canonicalManifest,
  canonicalPackage,
  createQiniuUploadConfig,
  immutablePackageKey,
  isBootstrapManifest,
  validateQiniuUploadResult,
} from '../scripts/bridge-release/release-cli.mjs'
import { normalizeDatabaseQiniuConfig } from '../scripts/bridge-release/database-qiniu-config.mjs'
import { startLocalReleaseRehearsal } from '../scripts/bridge-release/local-rehearsal-server.mjs'
import { verifyBridgeReleaseSignatures } from '../server/routes/bridge-release.js'

const execFileAsync = promisify(execFile)

describe('bridge release tooling', () => {
  it('auto-discovers Qiniu upload regions instead of pinning stale database hints', () => {
    const config = createQiniuUploadConfig('z0')
    expect(config.useHttpsDomain).toBe(true)
    expect(config.zone).toBeNull()
    expect(() => createQiniuUploadConfig('invalid')).toThrow('release_qiniu_region_invalid')
  })

  it('normalizes database Qiniu configuration without exposing it in release results', () => {
    expect(normalizeDatabaseQiniuConfig({
      access_key:'access-key', secret_key:'secret-key', bucket:'release-bucket',
      domain:'cdn.example.com', region:'z0',
    })).toEqual({
      QINIU_ACCESS_KEY:'access-key', QINIU_SECRET_KEY:'secret-key',
      QINIU_BUCKET:'release-bucket', QINIU_DOMAIN:'https://cdn.example.com', QINIU_REGION:'z0',
    })
    expect(() => normalizeDatabaseQiniuConfig({
      access_key:'access-key', secret_key:'secret-key', bucket:'release-bucket',
      domain:'http://cdn.example.com', region:'z0',
    })).toThrow('release_qiniu_database_domain_invalid')
    expect(() => normalizeDatabaseQiniuConfig({ domain:'cdn.example.com' }))
      .toThrow('release_qiniu_database_configuration_missing')
  })

  it('validates Qiniu upload responses without exposing provider response bodies', () => {
    expect(validateQiniuUploadResult({
      resp:{ statusCode:200 }, data:{ key:'bridge/releases/test.zip', hash:'etag' },
    }, 'bridge/releases/test.zip')).toBe('etag')
    expect(validateQiniuUploadResult({ resp:{ statusCode:614 }, data:{} }, 'existing')).toBeNull()
    expect(() => validateQiniuUploadResult({
      resp:{ statusCode:200 }, data:{ key:'wrong' },
    }, 'expected')).toThrow('release_qiniu_upload_response_key_mismatch')
    expect(() => validateQiniuUploadResult({
      resp:{ statusCode:400 }, data:{ error:'must not be surfaced' },
    }, 'expected')).toThrow('release_qiniu_upload_http_400')
  })

  it('reports exact missing release configuration names without exposing values', async () => {
    if (process.platform !== 'win32') return
    const script = path.resolve('scripts/bridge-release/preflight.ps1')
    const scrubbed = { ...process.env }
    for (const name of [
      'AURUM_BRIDGE_SIGNER_EXE', 'AURUM_BRIDGE_SIGNING_CERT_THUMBPRINT',
      'AURUM_AUTHENTICODE_CERT_THUMBPRINT',
      'BRIDGE_RELEASE_PUBLIC_KEY_PATH',
      'QINIU_ACCESS_KEY', 'QINIU_SECRET_KEY', 'QINIU_BUCKET', 'QINIU_DOMAIN',
      'QINIU_REGION', 'AURUM_BRIDGE_RELEASE_API_TOKEN', 'AURUM_METAEDITOR_EXE',
    ]) delete scrubbed[name]

    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Environment', 'test', '-DryRun',
    ], { env:scrubbed })
    const result = JSON.parse(stdout)

    expect(result).toMatchObject({ ok:true, operation:'preflight', environment:'test' })
    expect(result.qiniu_config_source).toBe('environment')
    expect(result.missing_requirements).toEqual(expect.arrayContaining([
      'AURUM_BRIDGE_SIGNER_EXE', 'BRIDGE_RELEASE_PUBLIC_KEY_PATH',
      'AURUM_AUTHENTICODE_CERT_THUMBPRINT_OR_ALLOW_UNSIGNED_INSTALLER',
      'QINIU_ACCESS_KEY', 'QINIU_SECRET_KEY', 'QINIU_BUCKET', 'QINIU_DOMAIN',
      'QINIU_REGION', 'AURUM_BRIDGE_RELEASE_API_TOKEN',
      'RELEASE_SERVER_HTTPS_URL', 'PYTHON_RUNTIME_DIRECTORY', 'AURUM_METAEDITOR_EXE',
    ]))
    expect(stdout).not.toContain('QINIU_SECRET_KEY=')
    expect(stdout).not.toContain('AURUM_BRIDGE_RELEASE_API_TOKEN=')
  })

  it('pins the portable MT5 Python runtime and enforces build provenance', async () => {
    const lock = await readFile(new URL('../bridge/adapters/mt5-python/requirements.lock.txt', import.meta.url), 'utf8')
    const runtimeBuilder = await readFile(new URL('../scripts/bridge-release/build-python-runtime.ps1', import.meta.url), 'utf8')
    const releaseBuilder = await readFile(new URL('../scripts/bridge-release/build-release.ps1', import.meta.url), 'utf8')
    expect(lock).toContain('MetaTrader5==5.0.5735')
    expect(lock).toContain('numpy==2.4.6')
    expect(lock.match(/--hash=sha256:[a-f0-9]{64}/g)).toHaveLength(2)
    expect(runtimeBuilder).toContain("'--require-hashes'")
    expect(runtimeBuilder).toContain("'--only-binary=:all:'")
    expect(runtimeBuilder).toContain('release_python_source_is_venv')
    expect(runtimeBuilder).toContain('release_python_runtime_smoke_test_failed')
    expect(releaseBuilder).toContain('& $cargo build --locked --release')
    expect(releaseBuilder).toContain('-p liangjian-bridge-ui -p liangjian-bridge-core')
    expect(releaseBuilder).toContain("Join-Path $core 'AURUMBridge.Core.exe'")
    expect(releaseBuilder).toContain("Join-Path $core 'launcher\\AURUMBridge.Launcher.exe'")
    expect(releaseBuilder).toContain("package_relative_path='launcher/AURUMBridge.Launcher.exe'")
    expect(releaseBuilder).toContain("Join-Path $nativeMt5Worker 'trade.py'")
    expect(releaseBuilder).toContain("implementation='rust-native'")
    expect(releaseBuilder).toContain('Assert-NativeReleaseLayout')
    expect(releaseBuilder).toContain('release_legacy_dotnet_artifact_present')
    expect(releaseBuilder).not.toContain('dotnet publish')
    expect(releaseBuilder).not.toContain("bridge\\app\\AurumBridge\\AurumBridge.csproj")
    expect(releaseBuilder).toContain('release_core_version_mismatch')
    expect(releaseBuilder).toContain('release_worker_version_mismatch')
    const nativeCoreResource = await readFile(
      new URL('../bridge/native/apps/bridge-core/build.rs', import.meta.url),
      'utf8',
    )
    expect(nativeCoreResource).toContain('AURUMBridge.Core.exe')
    expect(nativeCoreResource).toContain('embed_windows_executable_resource')
    expect(releaseBuilder).toContain('Start-Process -FilePath $MetaEditorExe')
    expect(releaseBuilder).toContain('-WindowStyle Hidden')
    expect(releaseBuilder).toContain('release_python_runtime_metadata_missing')
    expect(releaseBuilder).toContain("Join-Path $core 'server-endpoints.json'")
    expect(releaseBuilder).toContain('server_url=$serverUrlValue')
    expect(releaseBuilder).toContain('git_branch=$branch')
    expect(releaseBuilder).toContain('git_commit=$commit')
    expect(releaseBuilder).toContain('source_dirty=$dirty')
    expect(releaseBuilder).toContain("$TargetEnvironment -eq 'test'")
    expect(releaseBuilder).toContain('$domainUri.IsLoopback')
  })

  it('allows an HTTP CDN only for a loopback test rehearsal', async () => {
    if (process.platform !== 'win32') return
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-release-builder-'))
    const runtime = path.join(temporary, 'python-runtime')
    await mkdir(runtime)
    await writeFile(path.join(runtime, 'python.exe'), '')
    const script = path.resolve('scripts/bridge-release/build-release.ps1')
    const invoke = cdnDomain => execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ReleaseVersion', '9.9.7', '-Priority', 'normal', '-RolloutChannel', 'internal',
      '-RolloutPercentage', '100', '-PythonRuntimeDirectory', runtime,
      '-CdnDomain', cdnDomain, '-ServerUrl', 'http://127.0.0.1:3000',
      '-OutputDirectory', path.join(temporary, 'release-output'),
      '-TargetEnvironment', 'test', '-DryRun',
    ])
    try {
      const { stdout } = await invoke('http://127.0.0.1:3102')
      expect(JSON.parse(stdout)).toMatchObject({ ok:true, dry_run:true, environment:'test' })
      await expect(invoke('http://cdn.example')).rejects.toMatchObject({
        stderr:expect.stringContaining('release_cdn_domain_invalid'),
      })
      await expect(execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-ReleaseVersion', '9.9.7', '-Priority', 'normal', '-RolloutChannel', 'internal',
        '-RolloutPercentage', '100', '-PythonRuntimeDirectory', runtime,
        '-CdnDomain', 'http://127.0.0.1:3102', '-ServerUrl', 'https://bridge.example',
        '-OutputDirectory', path.join(temporary, 'release-output'),
        '-TargetEnvironment', 'test', '-DryRun',
      ])).rejects.toMatchObject({
        stderr:expect.stringContaining('release_test_server_must_be_loopback'),
      })
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('creates Windows release archives with portable forward-slash entry names', async () => {
    if (process.platform !== 'win32') return
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-portable-zip-'))
    const source = path.join(temporary, 'source')
    const nested = path.join(source, 'nested')
    const destination = path.join(temporary, 'package.zip')
    await mkdir(nested, { recursive:true })
    await writeFile(path.join(nested, 'worker.py'), 'print("ready")\n')
    try {
      const script = path.resolve('scripts/bridge-release/new-portable-zip.ps1')
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-SourceDirectory', source, '-Destination', destination,
      ])
      expect(JSON.parse(stdout)).toMatchObject({ ok:true, file_count:1 })
      const inspect = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$zip=[System.IO.Compression.ZipFile]::OpenRead('${destination.replaceAll("'", "''")}')`,
        'try { @($zip.Entries | ForEach-Object FullName) | ConvertTo-Json -Compress } finally { $zip.Dispose() }',
      ].join('; ')
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', inspect,
      ])
      const entries = JSON.parse(result.stdout)
      expect(entries).toContain('nested/worker.py')
      expect(entries.every(entry => !entry.includes('\\'))).toBe(true)
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('runs an isolated loopback release rehearsal without application services', async () => {
    const source = await readFile(
      new URL('../scripts/bridge-release/local-rehearsal-server.mjs', import.meta.url),
      'utf8',
    )
    expect(source).toContain("process.env.AURUM_BRIDGE_RELEASE_API_TOKEN")
    expect(source).not.toContain("required(args, 'release-token')")
    expect(source).toContain("const LOOPBACK_HOST = '127.0.0.1'")
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-release-rehearsal-'))
    const staticDirectory = path.join(temporary, 'static')
    const stateDirectory = path.join(temporary, 'state')
    const publicKeyPath = path.join(temporary, 'release-public-key.pem')
    await mkdir(staticDirectory)
    await writeFile(path.join(staticDirectory, 'probe.txt'), 'rehearsal-ready')
    await writeFile(publicKeyPath, 'test-public-key')
    const staleStateDirectory = path.join(temporary, 'stale-state')
    await mkdir(staleStateDirectory)
    await writeFile(path.join(staleStateDirectory, 'current.json'), '{}')
    await expect(startLocalReleaseRehearsal({
      stateDirectory:staleStateDirectory,
      staticDirectory,
      publicKeyPath,
      releaseToken:'local-rehearsal-token-32-characters-minimum',
      apiPort:0,
      staticPort:0,
    })).rejects.toThrow('local_rehearsal_state_directory_not_empty')
    const rehearsal = await startLocalReleaseRehearsal({
      stateDirectory,
      staticDirectory,
      publicKeyPath,
      releaseToken:'local-rehearsal-token-32-characters-minimum',
      apiPort:0,
      staticPort:0,
    })
    try {
      expect(new URL(rehearsal.apiUrl).hostname).toBe('127.0.0.1')
      expect(new URL(rehearsal.staticUrl).hostname).toBe('127.0.0.1')
      await expect(fetch(`${rehearsal.apiUrl}/health`).then(value => value.json()))
        .resolves.toEqual({ ok:true, service:'bridge-release-api' })
      await expect(fetch(`${rehearsal.staticUrl}/probe.txt`).then(value => value.text()))
        .resolves.toBe('rehearsal-ready')
      const unauthorized = await fetch(`${rehearsal.apiUrl}/api/admin/bridge/v3/releases/stop`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body:'{}',
      })
      expect(unauthorized.status).toBe(401)
      await expect(unauthorized.json()).resolves.toEqual({ ok:false, error:'unauthorized' })
    } finally {
      await rehearsal.close()
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('keeps the client activation rehearsal on loopback and reuses production update code', async () => {
    const tool = await readFile(
      new URL('../bridge/native/apps/bridge-update-rehearsal/src/main.rs', import.meta.url),
      'utf8',
    )
    const wrapper = await readFile(
      new URL('../scripts/bridge-release/test-local-client-update.ps1', import.meta.url),
      'utf8',
    )
    const fixtureBuilder = await readFile(
      new URL('../scripts/bridge-release/prepare-local-update-rehearsal.ps1', import.meta.url),
      'utf8',
    )
    const releaseTests = await readFile(
      new URL('../scripts/bridge-release/test-release.ps1', import.meta.url),
      'utf8',
    )
    const workspace = await readFile(new URL('../bridge/native/Cargo.toml', import.meta.url), 'utf8')
    expect(tool).toContain('validate_loopback_server')
    expect(tool).toContain('BridgeUpdateCoordinator::create_if_installed')
    expect(tool).toContain('LauncherEngine::new')
    expect(tool).toContain('NativeBridgeProcessRunner::new')
    expect(tool).toContain('AURUM_BRIDGE_RELEASE_API_TOKEN')
    expect(tool).toContain('update_rehearsal_second_health_check_failed')
    expect(wrapper).not.toContain('-ReleaseToken')
    expect(wrapper).toContain('-p liangjian-bridge-update-rehearsal')
    expect(wrapper).toContain('$env:AURUM_BRIDGE_DATA_DIR')
    expect(wrapper).toContain("$resultDocument.operation -ne 'client-update-rehearsal'")
    expect(wrapper).toContain('$rehearsalExitCode -eq 0')
    expect(wrapper).toContain('[IO.File]::WriteAllText($resultPath')
    expect(fixtureBuilder).toContain("$serverUri.Host -ne '127.0.0.1'")
    expect(fixtureBuilder).toContain("'sign-release.ps1'")
    expect(fixtureBuilder).toContain("'verify-signatures.ps1'")
    expect(releaseTests).toContain('& $dotnet build $solution')
    expect(workspace).toContain('"apps/bridge-update-rehearsal"')
  })

  it('builds a standard offline installer with a Rust backend and pins the signed native launcher from core', async () => {
    const bootstrapBuilder = await readFile(new URL('../scripts/bridge-release/build-bootstrapper.ps1', import.meta.url), 'utf8')
    const nativeInstallerBuilder = await readFile(new URL('../scripts/bridge-release/build-native-installer-backend.ps1', import.meta.url), 'utf8')
    const releaseBuilder = await readFile(new URL('../scripts/bridge-release/build-release.ps1', import.meta.url), 'utf8')
    const pythonRuntimeBuilder = await readFile(new URL('../scripts/bridge-release/build-python-runtime.ps1', import.meta.url), 'utf8')
    const pythonRuntimeOptimizer = await readFile(new URL('../scripts/bridge-release/optimize-python-runtime.ps1', import.meta.url), 'utf8')
    const fullInstallerBuilder = await readFile(new URL('../scripts/bridge-release/build-full-installer.ps1', import.meta.url), 'utf8')
    const bootstrapUploader = await readFile(new URL('../scripts/bridge-release/upload-bootstrapper-qiniu.ps1', import.meta.url), 'utf8')
    const nativeBootstrapMain = await readFile(new URL('../bridge/native/apps/bridge-bootstrapper/src/main.rs', import.meta.url), 'utf8')
    const nativeBootstrapGui = await readFile(new URL('../bridge/native/apps/bridge-bootstrapper/src/gui.rs', import.meta.url), 'utf8')
    const nativeInstaller = await readFile(new URL('../bridge/native/apps/bridge-installer/src/lib.rs', import.meta.url), 'utf8')
    const nativeReleaseValidator = await readFile(new URL('../bridge/native/crates/bridge-update/src/coordinator.rs', import.meta.url), 'utf8')
    const nativeCompliance = await readFile(new URL('../scripts/bridge-release/generate-native-compliance.ps1', import.meta.url), 'utf8')
    const localInstallerLifecycle = await readFile(new URL('../scripts/bridge-release/test-local-full-installer.ps1', import.meta.url), 'utf8')
    const nativeWorkspace = await readFile(new URL('../bridge/native/Cargo.toml', import.meta.url), 'utf8')
    const mt5Worker = await readFile(new URL('../bridge/native/workers/mt5/worker.py', import.meta.url), 'utf8')
    expect(bootstrapBuilder).toContain('-p liangjian-bridge-bootstrapper')
    expect(bootstrapBuilder).toContain('AURUM_BOOTSTRAPPER_SERVER_URL')
    expect(bootstrapBuilder).toContain("implementation='rust-native'")
    expect(bootstrapBuilder).not.toContain('dotnet publish')
    expect(bootstrapBuilder).toContain('bootstrap_unsigned_installer_confirmation_required')
    expect(bootstrapBuilder).toContain('unsigned_installer_authorized=$unsignedInstallerAuthorized')
    expect(bootstrapBuilder).toContain("$TargetEnvironment -eq 'test'")
    expect(bootstrapBuilder).toContain('$uri.IsLoopback')
    expect(bootstrapUploader).toContain("$signature.Status -eq 'Valid'")
    expect(bootstrapUploader).toContain('bootstrap_authenticode_metadata_mismatch')
    expect(bootstrapUploader).toContain('-AllowUnsignedInstaller:$AllowUnsignedInstaller')
    expect(nativeBootstrapMain).toContain('AURUM_BOOTSTRAPPER_TARGET_ENVIRONMENT')
    expect(nativeBootstrapMain).toContain('AURUM_BOOTSTRAPPER_SERVER_URL')
    expect(nativeBootstrapMain).toContain('"rehearsal-install-root"')
    expect(nativeBootstrapMain).toContain('"offline-bundle-root"')
    expect(nativeBootstrapGui).toContain('const WINDOW_WIDTH: i32 = 536')
    expect(nativeBootstrapGui).toContain('const WINDOW_HEIGHT: i32 = 252')
    expect(nativeBootstrapGui).toContain('const RETRY_TEXT: &str = "重试安装"')
    expect(nativeBootstrapGui).toContain('WM_INSTALL_COMPLETE')
    expect(nativeInstaller).toContain('BOOTSTRAP_MANIFEST_PATH')
    expect(nativeInstaller).toContain('/api/bridge/v3/releases/bootstrap')
    expect(nativeInstaller).toContain('ReleaseManifestClient::with_endpoint')
    expect(nativeInstaller).toContain('ReleasePackageStager::new')
    expect(nativeInstaller).toContain('InstallationIdentityStore::new')
    expect(bootstrapBuilder).toContain('single_runtime_installer=$true')
    expect(nativeInstallerBuilder).toContain("-p liangjian-bridge-installer")
    expect(nativeInstallerBuilder).toContain('native_offline_backend=$true')
    expect(nativeInstallerBuilder).toContain('AURUM_INSTALLER_PUBLIC_KEY_PATH')
    expect(nativeInstallerBuilder).toContain('AURUM_INSTALLER_TARGET_ENVIRONMENT')
    expect(nativeInstallerBuilder).not.toContain('dotnet publish')
    expect(nativeInstaller).toContain('bridge_processes_running()?')
    expect(nativeInstaller).toContain('register_installation(')
    expect(nativeInstaller).toContain('validate_native_release_layout')
    expect(nativeReleaseValidator).toContain('"launcher/AURUMBridge.Launcher.exe"')
    expect(nativeReleaseValidator).toContain('"AURUMBridge.Core.exe"')
    expect(nativeReleaseValidator).toContain('"modules/adapter.mt5.python/trade.py"')
    expect(nativeReleaseValidator).toContain('REJECTED_LEGACY_CORE_FILES')
    expect(nativeInstaller).toContain('start_launcher(')
    expect(fullInstallerBuilder).toContain("installer_type='full-offline-v3'")
    expect(fullInstallerBuilder).toContain('build-native-installer-backend.ps1')
    expect(fullInstallerBuilder).not.toContain("'build-bootstrapper.ps1'")
    expect(fullInstallerBuilder).toContain("installer_backend='rust-native-v3'")
    expect(fullInstallerBuilder).toContain('LiangjianBridgeInstallBackend.exe')
    expect(fullInstallerBuilder).toContain('[Icons]')
    expect(fullInstallerBuilder).toContain('Compression=lzma2/ultra64')
    expect(fullInstallerBuilder).toContain('OutputBaseFilename=LiangjianBridgeSetup')
    expect(fullInstallerBuilder).toContain('#define MyAppURL "$(Escape-Inno $serverUrlValue)"')
    expect(fullInstallerBuilder).toContain('full_installer_server_url_invalid')
    expect(fullInstallerBuilder).not.toContain('https://www.cnfxtrade.com')
    expect(fullInstallerBuilder).toContain('Uninstallable=no')
    expect(releaseBuilder).toContain('generate-native-compliance.ps1')
    expect(releaseBuilder).toContain('bridge-native.spdx.json')
    expect(releaseBuilder).toContain('THIRD-PARTY-LICENSES.txt')
    expect(nativeCompliance).toContain("@('openssl','openssl-sys','native-tls','hyper-tls','tokio-native-tls')")
    expect(nativeCompliance).toContain('release_forbidden_native_runtime_import')
    expect(nativeCompliance).toContain("@('.pdb','.d','.rlib','.lib','.exp','.obj','.ilk','.map','.pyc')")
    expect(nativeCompliance).toContain("spdxVersion = 'SPDX-2.3'")
    expect(nativeCompliance).toContain('PythonRuntimeDirectory')
    expect(nativeCompliance).toContain("name = 'CPython'")
    expect(nativeCompliance).toContain('pkg:pypi/')
    expect(nativeWorkspace).toContain('version = "3.0.3"')
    expect(nativeWorkspace).not.toContain('3.0.0-alpha')
    expect(mt5Worker).toContain('WORKER_VERSION = "3.0.3"')
    expect(pythonRuntimeBuilder).toContain('pruned_build_artifact_count')
    expect(pythonRuntimeBuilder).toContain('optimize-python-runtime.ps1')
    expect(releaseBuilder).toContain('python_runtime_pruning')
    expect(releaseBuilder).toContain('release_python_runtime_optimization_failed')
    expect(releaseBuilder).toContain('new-portable-zip.ps1')
    expect(releaseBuilder).not.toContain('CreateFromDirectory')
    expect(releaseBuilder).toContain('$runtimeMetadata.openssl_runtime_included -ne $false')
    expect(pythonRuntimeOptimizer).toContain("'DLLs\\libssl-3-x64.dll'")
    expect(pythonRuntimeOptimizer).toContain("'DLLs\\libcrypto-3-x64.dll'")
    expect(pythonRuntimeOptimizer).toContain("'Lib\\ensurepip'")
    expect(pythonRuntimeOptimizer).toContain("$python -I -B -c")
    expect(pythonRuntimeOptimizer).toContain('release_python_runtime_optimization_smoke_failed')
    expect(fullInstallerBuilder).toContain("bootstrapper-metadata.json")
    expect(fullInstallerBuilder).toContain('--offline-bundle-root')
    expect(fullInstallerBuilder).toContain("$manifest.rollout_channel -ne 'stable'")
    expect(fullInstallerBuilder).toContain('$MinimumOfflineValidityDays')
    expect(fullInstallerBuilder).toContain('rehearsal_result_path=$rehearsalResultPath')
    expect(localInstallerLifecycle).toContain("operation='test-local-full-installer'")
    expect(localInstallerLifecycle).toContain('local_installer_server_must_be_loopback')
    expect(localInstallerLifecycle).toContain('repair-sentinel.tmp')
    expect(localInstallerLifecycle).toContain("'--health-check','--health-file'")
    expect(localInstallerLifecycle).toContain("IndexOf('cnfxtrade.com'")
    expect(fullInstallerBuilder).toContain('function ConvertFrom-CodePoints')
    expect(fullInstallerBuilder).toContain('0x91CF,0x89C1,0x667A,0x6865')
    expect([...fullInstallerBuilder].some(character => character.codePointAt(0) > 0x7f)).toBe(false)
    const launcherProgram = await readFile(
      new URL('../bridge/launcher/AurumBridge.Launcher/Program.cs', import.meta.url),
      'utf8',
    )
    const launcherUninstaller = await readFile(
      new URL('../bridge/launcher/AurumBridge.Launcher/LauncherUninstaller.cs', import.meta.url),
      'utf8',
    )
    expect(launcherProgram).toContain('["--uninstall"]')
    expect(launcherUninstaller).toContain('BridgeInstallationRegistration.IsDefaultInstallRoot')
    expect(launcherUninstaller).toContain('RemoveRegistrationAndShortcuts')
  })

  it('generates a locked Native SPDX inventory and deduplicated third-party license bundle', async () => {
    if (process.platform !== 'win32') return
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-native-compliance-'))
    const output = path.join(temporary, 'compliance')
    try {
      const script = path.resolve('scripts/bridge-release/generate-native-compliance.ps1')
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-OutputDirectory', output,
        '-CargoManifest', path.resolve('bridge/native/Cargo.toml'),
      ], { maxBuffer:10 * 1024 * 1024 })
      const result = JSON.parse(stdout)
      const audit = JSON.parse(await readFile(path.join(output, 'native-dependency-audit.json'), 'utf8'))
      const sbom = JSON.parse(await readFile(path.join(output, 'bridge-native.spdx.json'), 'utf8'))
      const licenses = await readFile(path.join(output, 'THIRD-PARTY-LICENSES.txt'), 'utf8')
      expect(result).toMatchObject({ ok:true, operation:'generate-native-compliance' })
      expect(result.package_count).toBeGreaterThan(100)
      expect(audit.third_party_package_count).toBe(result.package_count)
      expect(audit.forbidden_tls_crates).toEqual([])
      expect(Object.values(audit.release_profile).every(Boolean)).toBe(true)
      expect(sbom).toMatchObject({ spdxVersion:'SPDX-2.3', dataLicense:'CC0-1.0' })
      expect(sbom.packages).toHaveLength(result.package_count)
      expect(sbom.documentNamespace).toMatch(/^urn:aurum:spdx:liangjian-bridge-native:[a-f0-9]{40}$/)
      expect(licenses).toContain('reqwest 0.13.4')
      expect(licenses).toContain('LICENSE TEXTS')
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('validates a complete offline V3 bundle without building or publishing it', async () => {
    if (process.platform !== 'win32') return
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-full-installer-builder-'))
    const output = path.join(temporary, 'output')
    try {
      const modules = ['core', 'adapter.mt5.python', 'adapter.mt4']
      const packages = []
      for (const module_id of modules) {
        const bytes = Buffer.from(`offline-${module_id}`)
        await writeFile(path.join(temporary, `${module_id}.zip`), bytes)
        packages.push({
          module_id, version:'3.1.0', size_bytes:bytes.length,
          sha256:createHash('sha256').update(bytes).digest('hex'),
          url:`https://cdn.example/${module_id}.zip`, signature:'c2ln',
        })
      }
      const manifest = {
        schema_version:2, release_id:'bridge-3.1.0-offline-test', release_version:'3.1.0',
        expires_at_utc_msc:Date.now() + 180 * 24 * 60 * 60 * 1000,
        priority:'normal', activation_deadline_utc_msc:null,
        rollout_channel:'stable', rollout_percentage:100, packages, signature:'c2ln',
      }
      const manifestPath = path.join(temporary, 'manifest.signed.json')
      const publicKey = path.join(temporary, 'release-public-key.pem')
      await writeFile(manifestPath, JSON.stringify(manifest))
      await writeFile(publicKey, 'test-public-key')
      const script = path.resolve('scripts/bridge-release/build-full-installer.ps1')
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-OutputDirectory', output,
        '-ReleaseDirectory', temporary,
        '-ManifestPath', manifestPath,
        '-PublicKey', publicKey,
        '-ServerUrl', 'http://127.0.0.1:3000',
        '-TargetEnvironment', 'test',
        '-MinimumOfflineValidityDays', '90',
        '-DryRun',
      ])
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'build-full-installer', dry_run:true,
        release_id:manifest.release_id, release_version:'3.1.0',
      })
      const production = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-OutputDirectory', path.join(temporary, 'production-output'),
        '-ReleaseDirectory', temporary,
        '-ManifestPath', manifestPath,
        '-PublicKey', publicKey,
        '-ServerUrl', 'https://www.cnfxtrade.com',
        '-TargetEnvironment', 'production',
        '-MinimumOfflineValidityDays', '90',
        '-DryRun',
      ])
      expect(JSON.parse(production.stdout)).toMatchObject({
        ok:true, operation:'build-full-installer', dry_run:true,
        environment:'production', release_version:'3.1.0',
      })
      const lifecycleScript = path.resolve('scripts/bridge-release/test-local-full-installer.ps1')
      const lifecycle = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lifecycleScript,
        '-ReleaseDirectory', temporary,
        '-ManifestPath', manifestPath,
        '-PublicKey', publicKey,
        '-OutputDirectory', path.join(temporary, 'lifecycle-output'),
        '-ServerUrl', 'http://127.0.0.1:3000',
        '-LauncherVersion', '3.1.0',
        '-DryRun',
      ])
      expect(JSON.parse(lifecycle.stdout)).toMatchObject({
        ok:true, operation:'test-local-full-installer', dry_run:true,
        release_version:'3.1.0', server_url:'http://127.0.0.1:3000',
      })
      await expect(execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lifecycleScript,
        '-ReleaseDirectory', temporary,
        '-ManifestPath', manifestPath,
        '-PublicKey', publicKey,
        '-OutputDirectory', path.join(temporary, 'remote-output'),
        '-ServerUrl', 'https://www.cnfxtrade.com',
        '-LauncherVersion', '3.1.0',
        '-DryRun',
      ])).rejects.toMatchObject({
        stderr:expect.stringContaining('local_installer_server_must_be_loopback'),
      })
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('allows an HTTP bootstrap API only for a loopback test rehearsal', async () => {
    if (process.platform !== 'win32') return
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-bootstrap-builder-'))
    const publicKey = path.join(temporary, 'release-public-key.pem')
    await writeFile(publicKey, '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n')
    const script = path.resolve('scripts/bridge-release/build-bootstrapper.ps1')
    const invoke = (environment, server) => execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-OutputDirectory', path.join(temporary, 'bootstrap-output'),
      '-PublicKey', publicKey, '-ServerUrl', server,
      '-TargetEnvironment', environment, '-DryRun',
    ])
    try {
      const { stdout } = await invoke('test', 'http://127.0.0.1:3101')
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, dry_run:true, environment:'test', server:'http://127.0.0.1:3101',
        loopback_server:'http://127.0.0.1:3000',
      })
      await expect(invoke('production', 'http://127.0.0.1:3101')).rejects.toMatchObject({
        stderr:expect.stringContaining('bootstrap_server_url_invalid'),
      })
      await expect(invoke('test', 'http://bootstrap.example')).rejects.toMatchObject({
        stderr:expect.stringContaining('bootstrap_server_url_invalid'),
      })
      await expect(invoke('test', 'https://bootstrap.example')).rejects.toMatchObject({
        stderr:expect.stringContaining('bootstrap_test_server_must_be_loopback'),
      })
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('matches the signed package and Manifest V2 canonical contracts', () => {
    const pkg = {
      module_id:'core', version:'3.1.0', url:'https://qiniu.example/bridge/core.zip',
      size_bytes:10, sha256:'A'.repeat(64), signature:'c2ln',
    }
    const manifest = {
      schema_version:2, release_id:'bridge-3.1.0-test', release_version:'3.1.0',
      generated_at_utc_msc:1, published_at_utc_msc:1, expires_at_utc_msc:2,
      priority:'normal', minimum_launcher_version:'1.0.0', minimum_idle_seconds:120,
      activation_deadline_utc_msc:null, rollout_channel:'stable', rollout_percentage:5,
      packages:[pkg],
    }
    expect(canonicalPackage(pkg)).toBe(`AURUM-PACKAGE-V1\ncore\n3.1.0\nhttps://qiniu.example/bridge/core.zip\n10\n${'a'.repeat(64)}\n\n\n`)
    expect(canonicalManifest(manifest)).toContain(`AURUM-RELEASE-V2\n2\nbridge-3.1.0-test\n3.1.0\n`)
    expect(canonicalManifest(manifest)).toContain(`core|3.1.0|https://qiniu.example/bridge/core.zip|10|${'a'.repeat(64)}|c2ln||\n`)
  })

  it('derives immutable Qiniu object keys from signed package identity', () => {
    const manifest = { release_version:'3.1.0' }
    const pkg = { module_id:'adapter.mt4', sha256:'A'.repeat(64) }
    expect(immutablePackageKey(manifest, pkg)).toBe(`bridge/releases/3.1.0/${'a'.repeat(64)}/adapter.mt4.zip`)
  })

  it('rejects a normal rollout manifest as a bootstrap pointer candidate', () => {
    const packages = ['core', 'adapter.mt5.python', 'adapter.mt4']
      .map(module_id => ({ module_id, signature:'package-signature' }))
    const candidate = {
      schema_version:2, priority:'normal', activation_deadline_utc_msc:null,
      rollout_channel:'stable', rollout_percentage:25,
      expires_at_utc_msc:1_900_000_000_000,
      packages, signature:'manifest-signature',
    }
    expect(isBootstrapManifest(candidate, 1_800_000_000_000)).toBe(false)
    expect(isBootstrapManifest({ ...candidate, rollout_percentage:100 }, 1_800_000_000_000)).toBe(true)
  })

  it('dry-runs an upload without Qiniu credentials or remote writes', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-release-test-'))
    try {
      const bytes = Buffer.from('release-package')
      const digest = createHash('sha256').update(bytes).digest('hex')
      await writeFile(path.join(temporary, 'core.zip'), bytes)
      const manifest = {
        schema_version:2, release_id:'bridge-3.1.0-dry-run', release_version:'3.1.0',
        packages:[{
          module_id:'core', version:'3.1.0', size_bytes:bytes.length, sha256:digest,
          url:`https://cdn.example/bridge/releases/3.1.0/${digest}/core.zip`, signature:'c2ln',
        }], signature:'c2ln',
      }
      const manifestPath = path.join(temporary, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest))
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const { stdout } = await execFileAsync(process.execPath, [
        cli, 'upload', '--manifest', manifestPath, '--artifacts', temporary, '--dry-run', 'true',
      ], {
        env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'', QINIU_BUCKET:'', QINIU_DOMAIN:'' },
      })
      const result = JSON.parse(stdout)
      expect(result).toMatchObject({ ok:true, operation:'upload', dry_run:true, release_id:manifest.release_id })
      expect(result.planned[0].key).toBe(`bridge/releases/3.1.0/${digest}/core.zip`)
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('dry-runs an immutable bootstrapper upload from exact build metadata', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-bootstrapper-upload-'))
    try {
      const executable = path.join(temporary, 'LiangjianBridgeSetup.exe')
      const bytes = Buffer.from('test bootstrapper')
      const digest = createHash('sha256').update(bytes).digest('hex')
      const metadataPath = path.join(temporary, 'bootstrapper-metadata.json')
      await writeFile(executable, bytes)
      await writeFile(metadataPath, JSON.stringify({
        schema_version:1, environment:'test', git_commit:'abc123',
        installer_size_bytes:bytes.length, installer_sha256:digest,
        authenticode_signed:false,
      }))
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const { stdout } = await execFileAsync(process.execPath, [
        cli, 'upload-bootstrapper', '--executable', executable,
        '--metadata', metadataPath, '--target-environment', 'test',
        '--cdn-origin', 'https://qiniu.example', '--dry-run', 'true',
      ], { env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' } })
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'upload-bootstrapper', dry_run:true, environment:'test',
        installer:{
          key:`bridge/bootstrapper/${digest}/LiangjianBridgeSetup.exe`,
          url:`https://qiniu.example/bridge/bootstrapper/${digest}/LiangjianBridgeSetup.exe`,
          size_bytes:bytes.length, sha256:digest,
        },
      })
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('requires two explicit confirmations before uploading an unsigned production installer', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-unsigned-bootstrapper-'))
    try {
      const executable = path.join(temporary, 'LiangjianBridgeSetup.exe')
      const bytes = Buffer.from('unsigned production bootstrapper')
      const digest = createHash('sha256').update(bytes).digest('hex')
      const metadataPath = path.join(temporary, 'bootstrapper-metadata.json')
      await writeFile(executable, bytes)
      await writeFile(metadataPath, JSON.stringify({
        schema_version:1, environment:'production', git_commit:'abc123',
        installer_size_bytes:bytes.length, installer_sha256:digest,
        authenticode_signed:false, unsigned_installer_authorized:false,
      }))
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const baseArguments = [
        cli, 'upload-bootstrapper', '--executable', executable,
        '--metadata', metadataPath, '--target-environment', 'production',
        '--cdn-origin', 'https://qiniu.example', '--dry-run', 'true',
      ]
      await expect(execFileAsync(process.execPath, baseArguments, {
        env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' },
      })).rejects.toMatchObject({
        stderr:expect.stringContaining('release_unsigned_bootstrapper_confirmation_required'),
      })
      await expect(execFileAsync(process.execPath, [
        ...baseArguments, '--allow-unsigned-installer', 'true',
      ], { env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' } })).rejects.toMatchObject({
        stderr:expect.stringContaining('release_unsigned_bootstrapper_confirmation_required'),
      })
      await writeFile(metadataPath, JSON.stringify({
        schema_version:1, environment:'production', git_commit:'abc123',
        installer_size_bytes:bytes.length, installer_sha256:digest,
        authenticode_signed:false, unsigned_installer_authorized:true,
      }))
      await expect(execFileAsync(process.execPath, baseArguments, {
        env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' },
      })).rejects.toMatchObject({
        stderr:expect.stringContaining('release_unsigned_bootstrapper_confirmation_required'),
      })
      const { stdout } = await execFileAsync(process.execPath, [
        ...baseArguments, '--allow-unsigned-installer', 'true',
      ], { env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' } })
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'upload-bootstrapper', dry_run:true, environment:'production',
        installer:{ sha256:digest, authenticode_signed:false },
      })
      if (process.platform === 'win32') {
        const wrapper = path.resolve('scripts/bridge-release/upload-bootstrapper-qiniu.ps1')
        const { stdout:wrapperStdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
          '-Executable', executable, '-Metadata', metadataPath,
          '-TargetEnvironment', 'production', '-CdnOrigin', 'https://qiniu.example',
          '-AllowUnsignedInstaller', '-DryRun',
        ], { env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' } })
        expect(JSON.parse(wrapperStdout)).toMatchObject({
          ok:true, operation:'upload-bootstrapper', dry_run:true, environment:'production',
          installer:{ sha256:digest, authenticode_signed:false },
        })
        await writeFile(metadataPath, JSON.stringify({
          schema_version:1, environment:'production', git_commit:'abc123',
          installer_size_bytes:bytes.length, installer_sha256:digest,
          authenticode_signed:true, unsigned_installer_authorized:false,
        }))
        await expect(execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
          '-Executable', executable, '-Metadata', metadataPath,
          '-TargetEnvironment', 'production', '-CdnOrigin', 'https://qiniu.example',
          '-AllowUnsignedInstaller', '-DryRun',
        ], { env:{ ...process.env, QINIU_ACCESS_KEY:'', QINIU_SECRET_KEY:'' } })).rejects.toMatchObject({
          stderr:expect.stringContaining('bootstrap_authenticode_metadata_mismatch'),
        })
      }
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('dry-runs a publish without an API token or server mutation', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-publish-test-'))
    try {
      const manifestPath = path.join(temporary, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({ release_id:'bridge-3.1.0-dry-run', release_version:'3.1.0' }))
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const { stdout } = await execFileAsync(process.execPath, [
        cli, 'publish', '--manifest', manifestPath, '--server', 'https://release.example', '--dry-run', 'true',
      ], { env:{ ...process.env, AURUM_BRIDGE_RELEASE_API_TOKEN:'' } })
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'publish', dry_run:true,
        endpoint:'https://release.example/api/admin/bridge/v3/releases/publish',
      })
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('derives a long-lived 100% bootstrap candidate without mutating the signed source', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-bootstrap-manifest-'))
    try {
      const sourcePath = path.join(temporary, 'source.json')
      const outputPath = path.join(temporary, 'bootstrap.json')
      const source = {
        schema_version:2, release_id:'bridge-3.1.0-stable', release_version:'3.1.0',
        generated_at_utc_msc:1, published_at_utc_msc:1, expires_at_utc_msc:2,
        priority:'urgent', minimum_launcher_version:'1.0.0', minimum_idle_seconds:120,
        activation_deadline_utc_msc:2, rollout_channel:'internal', rollout_percentage:25,
        packages:[
          { module_id:'core', signature:'package-signature' },
          { module_id:'adapter.mt5.python', signature:'package-signature' },
          { module_id:'adapter.mt4', signature:'package-signature' },
        ],
        signature:'manifest-signature',
      }
      await writeFile(sourcePath, JSON.stringify(source))
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const { stdout } = await execFileAsync(process.execPath, [
        cli, 'create-bootstrap-manifest', '--manifest', sourcePath,
        '--output', outputPath, '--validity-days', '365',
      ])
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'create-bootstrap-manifest',
        release_id:'bridge-3.1.0-stable.bootstrap', release_version:'3.1.0',
      })
      const bootstrap = JSON.parse(await readFile(outputPath, 'utf8'))
      expect(bootstrap).toMatchObject({
        priority:'normal', activation_deadline_utc_msc:null,
        rollout_channel:'stable', rollout_percentage:100, signature:'',
      })
      expect(bootstrap.packages).toEqual(source.packages)
      expect(JSON.parse(await readFile(sourcePath, 'utf8'))).toEqual(source)
      expect(bootstrap.expires_at_utc_msc - bootstrap.published_at_utc_msc)
        .toBe(365 * 24 * 60 * 60 * 1000)
    } finally {
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('verifies the exact signed Manifest returned by the public update endpoint', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-endpoint-test-'))
    const manifest = {
      schema_version:2, release_id:'bridge-3.1.0-endpoint', release_version:'3.1.0',
      priority:'normal', rollout_channel:'internal', rollout_percentage:100,
      packages:[], signature:'c2ln',
    }
    let receivedHeaders
    const server = createServer((request, response) => {
      receivedHeaders = request.headers
      response.writeHead(200, { 'Content-Type':'application/json' })
      response.end(JSON.stringify(manifest))
    })
    try {
      const manifestPath = path.join(temporary, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest))
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const installationId = `install_${'a'.repeat(32)}`
      const { stdout } = await execFileAsync(process.execPath, [
        cli, 'verify-endpoint', '--manifest', manifestPath,
        '--server', `http://127.0.0.1:${address.port}`,
        '--installation-id', installationId, '--release-channel', 'internal',
      ])
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'verify-endpoint', release_id:manifest.release_id,
        release_version:manifest.release_version, rollout_channel:'internal', rollout_percentage:100,
      })
      expect(receivedHeaders['x-aurum-installation-id']).toBe(installationId)
      expect(receivedHeaders['x-aurum-release-channel']).toBe('internal')
    } finally {
      server.close()
      await rm(temporary, { recursive:true, force:true })
    }
  })

  it('reads authenticated release health without mutating the rollout', async () => {
    let receivedRequest
    const server = createServer((request, response) => {
      receivedRequest = request
      response.writeHead(200, { 'Content-Type':'application/json' })
      response.end(JSON.stringify({
        ok:true,
        connected:{ installation_count:2, target_version_connected:1 },
        rollout:{ healthy:1, rolled_back:0, failed:0, pending:0 },
        stop_line:{ recommended:false, reasons:[] },
      }))
    })
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      const cli = path.resolve('scripts/bridge-release/release-cli.mjs')
      const { stdout } = await execFileAsync(process.execPath, [
        cli, 'health', '--server', `http://127.0.0.1:${address.port}`,
        '--freshness-seconds', '120',
      ], { env:{ ...process.env, AURUM_BRIDGE_RELEASE_API_TOKEN:'test-release-token' } })
      expect(JSON.parse(stdout)).toMatchObject({
        ok:true, operation:'health',
        response:{ connected:{ installation_count:2 }, stop_line:{ recommended:false } },
      })
      expect(receivedRequest.url).toBe('/api/admin/bridge/v3/releases/health?freshness_seconds=120')
      expect(receivedRequest.headers.authorization).toBe('Bearer test-release-token')
      expect(receivedRequest.method).toBe('GET')
    } finally {
      server.close()
    }
  })

  it('produces signatures accepted by the server and C# P1363 contract', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve:'prime256v1' })
    const pkg = {
      module_id:'core', version:'3.1.0', url:'https://qiniu.example/bridge/core.zip',
      size_bytes:10, sha256:'a'.repeat(64), signature:'',
    }
    pkg.signature = sign('sha256', Buffer.from(canonicalPackage(pkg)), {
      key:privateKey,
      dsaEncoding:'ieee-p1363',
    }).toString('base64')
    const manifest = {
      schema_version:2, release_id:'bridge-3.1.0-signed', release_version:'3.1.0',
      generated_at_utc_msc:1, published_at_utc_msc:1, expires_at_utc_msc:2,
      priority:'normal', minimum_launcher_version:'1.0.0', minimum_idle_seconds:120,
      activation_deadline_utc_msc:null, rollout_channel:'stable', rollout_percentage:5,
      packages:[pkg], signature:'',
    }
    manifest.signature = sign('sha256', Buffer.from(canonicalManifest(manifest)), {
      key:privateKey,
      dsaEncoding:'ieee-p1363',
    }).toString('base64')

    expect(verifyBridgeReleaseSignatures(
      manifest,
      publicKey.export({ type:'spki', format:'pem' }))).toBe(true)
  })
})
