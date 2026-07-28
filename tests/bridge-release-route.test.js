import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import {
  createBridgeReleaseRouter,
  isInstallationInRollout,
  validateBridgeReleaseManifest,
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

describe('bridge release manifest route', () => {
  it('serves a bounded public manifest without caching', async () => {
    const value = manifest()
    const response = await request(createBridgeReleaseRouter({
      manifestPath:'release.json',
      readManifest:vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))),
    }))

    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(response.body)).toEqual(value)
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
})
