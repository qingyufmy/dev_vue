import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createBridgeReleaseRouter,
  isInstallationInRollout,
  summarizeBridgeReleaseHealth,
  validateBridgeReleaseManifest,
  verifyBridgeReleaseSignatures,
} from '../server/routes/bridge-release.js'

function manifest(overrides = {}) {
  return {
    schema_version:1,
    release_version:'3.1.0',
    generated_at_utc_msc:1_800_000_000_000,
    minimum_launcher_version:'1.0.0',
    packages:[{
      module_id:'core',
      version:'3.1.0',
      url:'https://updates.example.com/core.zip',
      size_bytes:100,
      sha256:'a'.repeat(64),
      signature:'cGFja2FnZS1zaWduYXR1cmU=',
    }],
    signature:'signed-value',
    ...overrides,
  }
}

function manifestV2(overrides = {}) {
  return manifest({
    schema_version:2,
    release_id:'bridge-3.1.0-20260728.1',
    priority:'normal',
    published_at_utc_msc:1_800_000_000_000,
    expires_at_utc_msc:1_800_086_400_000,
    minimum_idle_seconds:120,
    activation_deadline_utc_msc:null,
    rollout_channel:'stable',
    rollout_percentage:10,
    ...overrides,
  })
}

function bootstrapManifestV2(overrides = {}) {
  const base = manifestV2({
    priority:'normal',
    activation_deadline_utc_msc:null,
    rollout_channel:'stable',
    rollout_percentage:100,
  })
  const core = base.packages[0]
  return {
    ...base,
    packages:[
      core,
      { ...core, module_id:'adapter.mt5.python', url:'https://updates.example.com/mt5.zip' },
      { ...core, module_id:'adapter.mt4', url:'https://updates.example.com/mt4.zip' },
    ],
    ...overrides,
  }
}

function request(router, headers = {}) {
  const app = express()
  app.use('/api', router)
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.get({
        hostname:'127.0.0.1',
        port:server.address().port,
        path:'/api/bridge/v3/releases/current',
        headers,
      }, res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          server.close()
          resolve({ status:res.statusCode, headers:res.headers, body })
        })
      })
      req.on('error', error => { server.close(); reject(error) })
    })
  })
}

function getRoute(router, routePath, headers = {}) {
  const app = express()
  app.use('/api', router)
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.get({
        hostname:'127.0.0.1', port:server.address().port,
        path:`/api${routePath}`, headers,
      }, res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => { server.close(); resolve({ status:res.statusCode, body }) })
      })
      req.on('error', error => { server.close(); reject(error) })
    })
  })
}

function mutate(router, routePath, body, headers = {}) {
  const app = express()
  app.use(express.json({ limit:'256kb' }))
  app.use('/api', router)
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body || {})
      const req = http.request({
        hostname:'127.0.0.1',
        port:server.address().port,
        path:`/api${routePath}`,
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload), ...headers },
      }, res => {
        let responseBody = ''
        res.on('data', chunk => { responseBody += chunk })
        res.on('end', () => {
          server.close()
          resolve({ status:res.statusCode, body:responseBody })
        })
      })
      req.on('error', error => { server.close(); reject(error) })
      req.end(payload)
    })
  })
}

describe('bridge release manifest route', () => {
  it('shares the native and dotnet P-256 golden manifest contract', async () => {
    const fixtureRoot = path.resolve('bridge/update-contract')
    const value = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest-v2.json'), 'utf8'))
    const publicKey = await readFile(path.join(fixtureRoot, 'release-public-key.pem'), 'utf8')

    expect(validateBridgeReleaseManifest(value, 1_800_000_000_100)).toBe(true)
    expect(verifyBridgeReleaseSignatures(value, publicKey)).toBe(true)
    expect(verifyBridgeReleaseSignatures({ ...value, priority:'urgent' }, publicKey)).toBe(false)
  })

  it('serves the bundled signed 3.0.0 release for updates and bootstrap', async () => {
    const router = createBridgeReleaseRouter({ now:() => 1_785_402_928_956 })
    const headers = {
      'X-Aurum-Installation-Id':'install_0123456789abcdef0123456789abcdef',
      'X-Aurum-Release-Channel':'stable',
    }

    const current = await request(router, headers)
    const bootstrap = await getRoute(router, '/bridge/v3/releases/bootstrap')

    expect(current.status).toBe(200)
    expect(bootstrap.status).toBe(200)
    expect(JSON.parse(current.body)).toMatchObject({
      release_id:'bridge-3.0.0-production-20260801.1',
      release_version:'3.0.0',
      rollout_percentage:100,
    })
    expect(JSON.parse(bootstrap.body)).toMatchObject({
      release_id:'bridge-3.0.0-production-20260801.1',
      release_version:'3.0.0',
      rollout_percentage:100,
    })
  })

  it('keeps the bundled fallback for equivalent relative runtime pointer paths', async () => {
    const router = createBridgeReleaseRouter({
      manifestPath:'server/data/bridge-release/current.json',
      bootstrapManifestPath:'server/data/bridge-release/bootstrap.json',
      now:() => 1_785_402_928_956,
    })
    const response = await request(router, {
      'X-Aurum-Installation-Id':'install_0123456789abcdef0123456789abcdef',
      'X-Aurum-Release-Channel':'stable',
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).release_id).toBe('bridge-3.0.0-production-20260801.1')
  })

  it('counts connected installations once and recommends stopping on rollback', () => {
    const value = summarizeBridgeReleaseHealth({
      manifest:manifestV2({ rollout_percentage:50 }),
      observedAtUtcMsc:1_800_000_100_000,
      sessions:[
        { terminal_instance_id:'main', installation_id:'install_0123456789abcdef0123456789abcdef', bridge_version:'3.1.0', last_seen_at_utc_msc:20 },
        { terminal_instance_id:'observer', installation_id:'install_0123456789abcdef0123456789abcdef', bridge_version:'3.1.0', last_seen_at_utc_msc:10 },
        { terminal_instance_id:'legacy', installation_id:null, bridge_version:'3.0.0', last_seen_at_utc_msc:20 },
      ],
      events:[{
        installation_id:'install_0123456789abcdef0123456789abcdef',
        state:'rolled_back', started_at_utc_msc:1000, updated_at_utc_msc:4000,
      }],
    })
    expect(value.connected).toMatchObject({
      terminal_count:3, installation_count:1, legacy_terminal_count:1,
      versions:{ '3.1.0':1 }, target_version_connected:1,
    })
    expect(value.rollout).toMatchObject({
      expected_installations:1, reporting_installations:1, rolled_back:1,
      average_recovery_duration_msc:3000,
    })
    expect(value.stop_line).toMatchObject({
      recommended:true, reasons:['client_rolled_back'],
    })
  })

  it('serves authenticated installation coverage from fresh terminal sessions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-release-health-'))
    try {
      const manifestPath = path.join(directory, 'current.json')
      const value = manifestV2({ rollout_percentage:100 })
      await writeFile(manifestPath, JSON.stringify(value))
      const queryAllFn = vi.fn(async sql => sql.includes('bridge_v3_terminal_sessions')
        ? [{
            terminal_instance_id:'main',
            installation_id:'install_0123456789abcdef0123456789abcdef',
            bridge_version:'3.1.0', last_seen_at_utc_msc:1_800_000_000_000,
          }]
        : [{
            installation_id:'install_0123456789abcdef0123456789abcdef',
            state:'healthy', started_at_utc_msc:1_799_999_900_000,
            updated_at_utc_msc:1_800_000_000_000,
          }])
      const router = createBridgeReleaseRouter({
        manifestPath, authenticate:(req, res, next) => next(),
        requireAdmin:(req, res, next) => next(), queryAllFn,
        now:() => 1_800_000_000_000,
      })
      const response = await getRoute(router, '/admin/bridge/v3/releases/health?freshness_seconds=90')
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({
        ok:true,
        connected:{ installation_count:1, target_version_connected:1 },
        rollout:{ healthy:1, pending:0 },
        stop_line:{ recommended:false },
      })
      expect(queryAllFn.mock.calls[0][1]).toEqual([1_799_999_910_000])
    } finally {
      await rm(directory, { recursive:true, force:true })
    }
  })

  it('serves a bounded public manifest without caching', async () => {
    const value = manifest()
    const response = await request(createBridgeReleaseRouter({
      manifestPath:'release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))),
    }))

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(response.body)).toEqual(value)
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/)
  })

  it('returns not modified only after revalidating the selected manifest', async () => {
    const value = manifest()
    const router = createBridgeReleaseRouter({
      manifestPath:'release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))),
    })
    const first = await request(router)
    const second = await request(router, { 'If-None-Match':first.headers.etag })

    expect(first.status).toBe(200)
    expect(second.status).toBe(304)
    expect(second.body).toBe('')
  })

  it('returns no content when releases are not configured', async () => {
    const response = await request(createBridgeReleaseRouter({ manifestPath:'' }))

    expect(response.status).toBe(204)
    expect(response.body).toBe('')
  })

  it('fails closed without exposing malformed release content', async () => {
    const response = await request(createBridgeReleaseRouter({
      manifestPath:'C:\\private\\release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(manifest({ signature:'' })))),
    }))

    expect(response.status).toBe(503)
    expect(response.body).not.toContain('C:\\private')
    expect(JSON.parse(response.body)).toEqual({ ok:false, error:'bridge_release_unavailable' })
  })

  it('rejects duplicate modules, credentials in URLs and invalid compatibility versions', () => {
    expect(validateBridgeReleaseManifest(manifest({
      packages:[manifest().packages[0], manifest().packages[0]],
    }))).toBe(false)
    expect(validateBridgeReleaseManifest(manifest({
      packages:[{ ...manifest().packages[0], url:'https://user:pass@updates.example.com/core.zip' }],
    }))).toBe(false)
    expect(validateBridgeReleaseManifest(manifest({
      packages:[{ ...manifest().packages[0], minimum_core_version:'next' }],
    }))).toBe(false)
    expect(validateBridgeReleaseManifest(manifest({
      packages:[{ ...manifest().packages[0], signature:'' }],
    }))).toBe(false)
  })

  it('accepts bounded v2 rollout policy and rejects unsafe activation metadata', () => {
    const now = 1_800_000_000_100
    expect(validateBridgeReleaseManifest(manifestV2(), now)).toBe(true)
    expect(validateBridgeReleaseManifest(manifestV2({ priority:'critical' }), now)).toBe(false)
    expect(validateBridgeReleaseManifest(manifestV2({ minimum_idle_seconds:0 }), now)).toBe(false)
    expect(validateBridgeReleaseManifest(manifestV2({ expires_at_utc_msc:now }), now)).toBe(false)
    expect(validateBridgeReleaseManifest(manifestV2({
      activation_deadline_utc_msc:1_800_086_400_001,
    }), now)).toBe(false)
    expect(validateBridgeReleaseManifest(manifestV2({ rollout_percentage:0 }), now)).toBe(false)
  })

  it('uses a stable installation bucket and keeps release channels isolated', async () => {
    const value = manifestV2({ rollout_percentage:25 })
    const firstId = 'install_0123456789abcdef0123456789abcdef'
    const sameDecision = isInstallationInRollout(value, firstId, 'stable')
    expect(isInstallationInRollout(value, firstId, 'stable')).toBe(sameDecision)
    expect(isInstallationInRollout(value, firstId, 'internal')).toBe(false)
    expect(isInstallationInRollout(value, 'invalid', 'stable')).toBe(false)

    const response = await request(createBridgeReleaseRouter({
      manifestPath:'release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))),
    }), {
      'X-Aurum-Installation-Id':firstId,
      'X-Aurum-Release-Channel':'internal',
    })
    expect(response.status).toBe(204)
  })

  it('fails a selected v2 public release closed when signature verification is unavailable', async () => {
    const value = manifestV2({ rollout_percentage:100 })
    const response = await request(createBridgeReleaseRouter({
      manifestPath:'release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))),
    }), {
      'X-Aurum-Installation-Id':'install_0123456789abcdef0123456789abcdef',
      'X-Aurum-Release-Channel':'stable',
    })
    expect(response.status).toBe(503)
  })

  it('serves a selected v2 public release only after server-side signature verification', async () => {
    const value = manifestV2({ rollout_percentage:100 })
    const response = await request(createBridgeReleaseRouter({
      manifestPath:'release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))),
      publicKeyPath:'public-key.pem',
      fileOps:{
        mkdir:vi.fn(), rename:vi.fn(), rm:vi.fn(), writeFile:vi.fn(),
        readFile:vi.fn(async target => {
          if (target === 'public-key.pem') return 'public-key'
          throw Object.assign(new Error('missing'), { code:'ENOENT' })
        }),
      },
      verifySignatures:vi.fn().mockReturnValue(true),
    }), {
      'X-Aurum-Installation-Id':'install_0123456789abcdef0123456789abcdef',
      'X-Aurum-Release-Channel':'stable',
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual(value)
  })

  it('publishes, stops and rolls back signed manifest pointers atomically', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-release-route-'))
    try {
      const manifestPath = path.join(directory, 'current.json')
      const publicKeyPath = path.join(directory, 'public-key.pem')
      const notifyReleaseAvailable = vi.fn()
      await writeFile(publicKeyPath, 'test-public-key')
      const router = createBridgeReleaseRouter({
        manifestPath,
        authenticate:(req, res, next) => next(),
        requireAdmin:(req, res, next) => next(),
        publicKeyPath,
        verifySignatures:() => true,
        notifyReleaseAvailable,
      })
      const first = manifestV2({
        release_id:'bridge-3.1.0-first',
        rollout_percentage:5,
      })
      const second = manifestV2({
        release_id:'bridge-3.1.0-second',
        rollout_percentage:25,
      })

      expect((await mutate(router, '/admin/bridge/v3/releases/publish', { manifest:first })).status).toBe(200)
      expect((await mutate(router, '/admin/bridge/v3/releases/publish', { manifest:second })).status).toBe(200)
      expect((await mutate(router, '/admin/bridge/v3/releases/stop')).status).toBe(200)
      expect((await request(router, {
        'X-Aurum-Installation-Id':'install_0123456789abcdef0123456789abcdef',
        'X-Aurum-Release-Channel':'stable',
      })).status).toBe(204)
      const rollback = await mutate(router, '/admin/bridge/v3/releases/rollback')
      expect(rollback.status).toBe(200)
      expect(JSON.parse(rollback.body).release_id).toBe(first.release_id)
      expect(notifyReleaseAvailable.mock.calls).toEqual([
        [{
          releaseId:first.release_id,
          releaseVersion:first.release_version,
          rolloutChannel:first.rollout_channel,
          reason:'published',
        }],
        [{
          releaseId:second.release_id,
          releaseVersion:second.release_version,
          rolloutChannel:second.rollout_channel,
          reason:'published',
        }],
        [{
          releaseId:first.release_id,
          releaseVersion:first.release_version,
          rolloutChannel:first.rollout_channel,
          reason:'rollback',
        }],
      ])
    } finally {
      await rm(directory, { recursive:true, force:true })
    }
  })

  it('serves only an explicitly promoted 100% release to new installations and rolls it back', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-bootstrap-route-'))
    try {
      const bootstrapManifestPath = path.join(directory, 'bootstrap.json')
      const publicKeyPath = path.join(directory, 'public-key.pem')
      await writeFile(publicKeyPath, 'test-public-key')
      const router = createBridgeReleaseRouter({
        manifestPath:path.join(directory, 'current.json'),
        bootstrapManifestPath,
        authenticate:(req, res, next) => next(),
        requireAdmin:(req, res, next) => next(),
        publicKeyPath,
        verifySignatures:() => true,
      })
      const canary = bootstrapManifestV2({ release_id:'bridge-3.1.0-canary', rollout_percentage:25 })
      const first = bootstrapManifestV2({ release_id:'bridge-3.0.0-bootstrap', release_version:'3.0.0' })
      const second = bootstrapManifestV2({ release_id:'bridge-3.1.0-bootstrap' })
      expect((await mutate(router, '/admin/bridge/v3/releases/promote-bootstrap', { manifest:{ packages:{} } })).status).toBe(400)
      expect((await mutate(router, '/admin/bridge/v3/releases/promote-bootstrap', { manifest:canary })).status).toBe(400)
      await writeFile(bootstrapManifestPath, JSON.stringify(canary))
      expect((await getRoute(router, '/bridge/v3/releases/bootstrap')).status).toBe(503)
      expect((await mutate(router, '/admin/bridge/v3/releases/promote-bootstrap', { manifest:first })).status).toBe(200)
      expect(JSON.parse((await getRoute(router, '/bridge/v3/releases/bootstrap')).body)).toEqual(first)
      expect((await mutate(router, '/admin/bridge/v3/releases/promote-bootstrap', { manifest:second })).status).toBe(200)
      expect(JSON.parse((await getRoute(router, '/bridge/v3/releases/bootstrap')).body)).toEqual(second)
      const rollback = await mutate(router, '/admin/bridge/v3/releases/rollback-bootstrap')
      expect(rollback.status).toBe(200)
      expect(JSON.parse(rollback.body).release_id).toBe(first.release_id)
      expect(JSON.parse((await getRoute(router, '/bridge/v3/releases/bootstrap')).body)).toEqual(first)
    } finally {
      await rm(directory, { recursive:true, force:true })
    }
  })

  it('accepts a dedicated constant-time release token without requiring a user JWT', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-release-token-'))
    try {
      const releaseToken = 'release-token-for-automation-only-1234567890'
      const publicKeyPath = path.join(directory, 'public-key.pem')
      await writeFile(publicKeyPath, 'test-public-key')
      const router = createBridgeReleaseRouter({
        manifestPath:path.join(directory, 'current.json'),
        authenticate:vi.fn(() => { throw new Error('user auth should not run') }),
        requireAdmin:vi.fn(() => { throw new Error('admin auth should not run') }),
        publicKeyPath,
        releaseToken,
        verifySignatures:() => true,
      })
      const response = await mutate(router, '/admin/bridge/v3/releases/publish', {
        manifest:manifestV2({ release_id:'bridge-3.1.0-token', rollout_percentage:5 }),
      }, { Authorization:`Bearer ${releaseToken}` })
      expect(response.status).toBe(200)
    } finally {
      await rm(directory, { recursive:true, force:true })
    }
  })
})
