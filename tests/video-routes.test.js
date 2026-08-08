import express from 'express'
import http from 'http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryOne, queryAll, queryRun } = vi.hoisted(() => ({
  queryOne:vi.fn(),
  queryAll:vi.fn(),
  queryRun:vi.fn(),
}))

vi.mock('../server/db.js', () => ({ queryOne, queryAll, queryRun }))
vi.mock('../server/middleware/auth.js', () => ({
  optionalAuth: (req, res, next) => { req.user = { id:7, role:'user', plan:'pro' }; next() },
  authMiddleware: (req, res, next) => { req.user = { id:7, role:'user', plan:'pro' }; next() },
  adminOnly: (req, res, next) => next(),
}))
vi.mock('../server/utils.js', () => ({ fetchBilibiliVideo:vi.fn() }))

import videoRouter from '../server/routes/video.js'

function get(path) {
  return new Promise((resolve, reject) => {
    const app = express()
    app.use('/api', videoRouter)
    const server = app.listen(0, () => {
      const request = http.get({ hostname:'127.0.0.1', port:server.address().port, path }, response => {
        let data = ''
        response.on('data', chunk => { data += chunk })
        response.on('end', () => {
          server.close()
          resolve({ status:response.statusCode, body:JSON.parse(data) })
        })
      })
      request.on('error', reject)
    })
  })
}

describe('video routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a signed API media URL after membership authorization', async () => {
    queryOne
      .mockResolvedValueOnce({ id:3, episode_id:6, local_path:'/uploads/videos/video_demo.mp4', access_level:'pro_only' })
      .mockResolvedValueOnce({ episode_id:6, local_video_path:'/uploads/videos/video_demo.mp4', access_level:'pro_only' })

    const result = await get('/api/video-stream?episode=6')

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.localPath).toMatch(/^\/api\/video-file\/video_demo\.mp4\?viewer=7&expires=\d+&signature=[a-f0-9]{64}$/)
    expect(result.body.stream.localPath).toBe(result.body.localPath)
  })
})
