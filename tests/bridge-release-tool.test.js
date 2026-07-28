import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { canonicalManifest, canonicalPackage, immutablePackageKey } from '../scripts/bridge-release/release-cli.mjs'
import { verifyBridgeReleaseSignatures } from '../server/routes/bridge-release.js'

const execFileAsync = promisify(execFile)

describe('bridge release tooling', () => {
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
    expect(releaseBuilder).toContain('-p:Version=$ReleaseVersion')
    expect(releaseBuilder).toContain('release_core_version_mismatch')
    expect(releaseBuilder).toContain('Start-Process -FilePath $MetaEditorExe')
    expect(releaseBuilder).toContain('-WindowStyle Hidden')
    expect(releaseBuilder).toContain('release_python_runtime_metadata_missing')
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
