import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/db.js', () => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../server/utils.js', () => ({
  fetchBilibiliVideo: vi.fn(),
  BILIBILI_HEADERS: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' },
}))

vi.mock('../../server/middleware/auth.js', () => ({
  optionalAuth: (req, res, next) => next(),
  authMiddleware: (req, res, next) => {
    req.user = { id: 1, role: 'user' }
    next()
  },
}))

import { queryAll } from '../../server/db.js'
import { fetchBilibiliVideo } from '../../server/utils.js'
import coursesRouter from '../../server/routes/courses.js'

function makeApp() {
  const app = express()
  app.use('/api', coursesRouter)
  return app
}

function httpGet(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          server.close()
          resolve(JSON.parse(data))
        })
      }).on('error', reject)
    })
  })
}

describe('courses.js — GET /course-items', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回课程列表', async () => {
    queryAll.mockResolvedValueOnce([
      { episode_id: 1, number: 1, title: '测试课程', description: 'desc', category: 'indicator',
        content_type: 'video', duration: '18:30', youtube_id: 'abc', bilibili_id: '',
        cover: '/covers/ep01.webp', gradient: 'linear-gradient(135deg, #667eea, #764ba2)',
        article_url: '', article_object_key: '', access_level: 'free', has_stream_video: 0,
        quiz_count: 0, knowledge_count: 0, mindmap_count: 0, structure_count: 0,
        status: 'published', sort_order: 1, created_at: '2026-01-01', updated_at: '2026-01-01',
        vs_duration: null }
    ])

    const body = await httpGet(makeApp(), '/api/course-items')
    expect(body.ok).toBe(true)
    expect(body.courses).toHaveLength(1)
    expect(body.courses[0].title).toBe('测试课程')
  })

  it('未登录或会员过期时不下发受限课程资源地址', async () => {
    queryAll.mockResolvedValueOnce([{
      episode_id: 2, number: 2, title: '会员课程', content_type: 'video',
      youtube_id: 'secret-youtube', bilibili_id: 'secret-bvid', article_url: 'https://secret.example.com',
      article_object_key: 'private/article.md', access_level: 'plus_pro', has_stream_video: 1,
    }])
    const body = await httpGet(makeApp(), '/api/course-items')
    expect(body.courses[0]).toMatchObject({ youtubeId:null, bilibiliId:'', articleUrl:'', articleObjectKey:'' })
  })
})

describe('courses.js — GET /bilibili-info/:bvid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('成功返回 B 站视频信息', async () => {
    fetchBilibiliVideo.mockResolvedValueOnce({
      cover: 'https://example.com/cover.jpg',
      duration: 2055,
      title: '字幕君交流场所',
      cid: 12345,
    })

    const body = await httpGet(makeApp(), '/api/bilibili-info/BV1xx411c7mD')
    expect(body.ok).toBe(true)
    expect(body.title).toBe('字幕君交流场所')
    expect(body.durationFormatted).toBe('34:15')
  })

  it('B 站 API 失败时返回错误', async () => {
    fetchBilibiliVideo.mockResolvedValueOnce(null)

    const body = await httpGet(makeApp(), '/api/bilibili-info/invalid')
    expect(body.ok).toBe(false)
  })
})
