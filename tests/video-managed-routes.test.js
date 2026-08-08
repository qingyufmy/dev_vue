import express from 'express'
import http from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryOne, queryAll, queryRun, loadStoredFile, createStorageService } = vi.hoisted(() => ({
  queryOne: vi.fn(), queryAll: vi.fn(), queryRun: vi.fn(), loadStoredFile: vi.fn(), createStorageService: vi.fn(),
}))

vi.mock('../server/db.js', () => ({ queryOne, queryAll, queryRun, withTransaction: vi.fn() }))
vi.mock('../server/storage/stored-file-service.js', () => ({
  loadStoredFile,
  createDirectStorageSession: vi.fn(), createMultipartStoredFile: vi.fn(), confirmDirectStorageSession: vi.fn(), safeStorageError: (error, fallback) => Object.assign(new Error(error?.code || fallback), { code: error?.code || fallback }),
}))
vi.mock('../server/storage/storage-service.js', () => ({ createStorageService }))
vi.mock('../server/middleware/auth.js', () => ({
  optionalAuth: (req, _res, next) => { req.user = { id: 7, role: 'user', plan: 'pro' }; next() },
  authMiddleware: (req, _res, next) => { req.user = { id: 7, role: 'admin', plan: 'pro' }; next() },
  adminOnly: (_req, _res, next) => next(),
}))
vi.mock('../server/utils.js', () => ({ fetchBilibiliVideo: vi.fn() }))

import videoRouter from '../server/routes/video.js'

function get(path) {
  return new Promise((resolve, reject) => {
    const app = express();app.use('/api', videoRouter)
    const server = app.listen(0, () => {
      const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path }, response => {
        let body = '';response.on('data', chunk => { body += chunk });response.on('end', () => { server.close();resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }) })
      });req.on('error', reject)
    })
  })
}

describe('managed video playback routes', () => {
  beforeEach(() => { vi.clearAllMocks();createStorageService.mockResolvedValue({ createReadUrl: vi.fn().mockResolvedValue('https://cdn.example.test/signed-private-url'), configuredProvider: vi.fn().mockReturnValue('qiniu') }) })

  it('uses explicit qiniu_mp4 playback even when a legacy Bilibili id remains', async () => {
    queryOne.mockResolvedValueOnce({ id: 42, episode_id: 6, stored_file_id: 9, video_source: 'qiniu_mp4', access_level: 'pro_only', qiniu_key: 'legacy-should-not-leak', bilibili_id: 'BVlegacy' }).mockResolvedValueOnce({ episode_id: 6, bilibili_id: 'BVlegacy', youtube_id: '', access_level: 'pro_only' })
    loadStoredFile.mockResolvedValue({ id: 9, status: 'ready', storage_provider: 'qiniu', object_key: 'website/dev/video/managed42' })
    const result = await get('/api/video-stream?episode=6')
    expect(result.status).toBe(200)
    expect(result.headers['cache-control']).toContain('private')
    expect(result.body.videoSource).toBe('qiniu_mp4')
    expect(result.body.playbackUrl).toContain('signed-private-url')
    expect(result.body.qiniuKey).toBe('')
  })
})
