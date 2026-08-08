import express from 'express'
import http from 'node:http'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSignedManagedVideoUrl } from '../server/video-access.js'

const { queryOne, queryAll, queryRun, createStorageService } = vi.hoisted(() => ({ queryOne: vi.fn(), queryAll: vi.fn(), queryRun: vi.fn(), createStorageService: vi.fn() }))
vi.mock('../server/db.js', () => ({ queryOne, queryAll, queryRun, withTransaction: vi.fn() }))
vi.mock('../server/storage/storage-service.js', () => ({ createStorageService }))
vi.mock('../server/storage/stored-file-service.js', () => ({ loadStoredFile: vi.fn(), createDirectStorageSession: vi.fn(), createMultipartStoredFile: vi.fn(), confirmDirectStorageSession: vi.fn(), safeStorageError: (error, fallback) => Object.assign(new Error(error?.code || fallback), { code: error?.code || fallback }) }))
vi.mock('../server/middleware/auth.js', () => ({ optionalAuth: (req, _res, next) => { req.user = { id: 7, role: 'user', plan: 'pro' }; next() }, authMiddleware: (req, _res, next) => next(), adminOnly: (_req, _res, next) => next() }))

import managedRouter from '../server/routes/video-managed.js'

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const app = express();app.use('/api', managedRouter)
    const server = app.listen(0, () => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers }, response => { const chunks=[];response.on('data', chunk => chunks.push(chunk));response.on('end', () => { server.close();resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }) }) })
      req.on('error', reject)
    })
  })
}

describe('managed local video response', () => {
  beforeEach(() => { vi.clearAllMocks();createStorageService.mockResolvedValue({ providerNamed: vi.fn().mockReturnValue({ stat: vi.fn().mockResolvedValue({ sizeBytes: 10 }), read: vi.fn(({ start = 0, end = 9 }) => Readable.from(Buffer.from('0123456789').subarray(start, end + 1))) }) }) })

  it('serves strict 206 ranges with no-store and nosniff', async () => {
    queryOne.mockResolvedValue({ id: 12, episode_id: 6, stored_file_id: 88, video_source: 'local_mp4', object_key: 'website/dev/video/managed12', storage_provider: 'local', size_bytes: 10, mime_type: 'video/mp4', access_level: 'pro_only', course_access_level: 'pro_only' })
    const signed = buildSignedManagedVideoUrl(12, 7)
    const ranged = await request(signed, { Range: 'bytes=2-5' })
    expect(ranged.status).toBe(206)
    expect(ranged.body.toString()).toBe('2345')
    expect(ranged.headers['content-range']).toBe('bytes 2-5/10')
    expect(ranged.headers['x-content-type-options']).toBe('nosniff')
    expect(ranged.headers['cache-control']).toContain('private')
    const invalid = await request(signed, { Range: 'bytes=10-11' })
    expect(invalid.status).toBe(416)
  })
})
