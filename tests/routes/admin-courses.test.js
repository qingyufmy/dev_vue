import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    req.user = { id: 1, role: 'admin' }
    next()
  },
  adminOnly: (req, res, next) => next(),
}))

vi.mock('../../server/utils.js', () => ({
  fetchBilibiliVideo: vi.fn(),
}))

import { queryOne, queryRun, logAudit } from '../../server/db.js'
import adminRouter from '../../server/routes/admin.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', adminRouter)
  return app
}

function httpPost(app, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, response => {
        let data = ''
        response.on('data', chunk => { data += chunk })
        response.on('end', () => {
          server.close()
          resolve({ status: response.statusCode, body: JSON.parse(data) })
        })
      })
      request.on('error', reject)
      request.write(JSON.stringify(body))
      request.end()
    })
  })
}

function httpPut(app, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const request = http.request({ hostname:'127.0.0.1', port:server.address().port, path, method:'PUT', headers:{ 'Content-Type':'application/json' } }, response => {
        let data=''
        response.on('data', chunk => { data += chunk })
        response.on('end', () => { server.close(); resolve({ status:response.statusCode, body:JSON.parse(data) }) })
      })
      request.on('error', reject)
      request.write(JSON.stringify(body))
      request.end()
    })
  })
}

function coursePayload(overrides = {}) {
  return {
    title: '黄金早盘',
    category: 'morning',
    contentType: 'article',
    articleUrl: '/articles/morning.html',
    status: 'published',
    ...overrides,
  }
}

describe('admin course publishing category', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects missing and unsupported categories', async () => {
    const missing = await httpPost(makeApp(), '/api/admin-course-items', coursePayload({ category: '' }))
    const invalid = await httpPost(makeApp(), '/api/admin-course-items', coursePayload({ category: 'all' }))

    expect(missing).toEqual({ status: 400, body: { ok: false, error: '请选择发布栏目' } })
    expect(invalid).toEqual({ status: 400, body: { ok: false, error: '无效的发布栏目' } })
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('persists the selected category and returns the episode id', async () => {
    queryOne
      .mockResolvedValueOnce({ m: 10 })
      .mockResolvedValueOnce({
        id: 99,
        episode_id: 11,
        title: '指标视频',
        category: 'indicator',
        content_type: 'video',
        status: 'published',
      })
    queryRun.mockResolvedValueOnce({ affectedRows: 1 })

    const result = await httpPost(makeApp(), '/api/admin-course-items', coursePayload({
      title: '指标视频',
      category: 'indicator',
      contentType: 'video',
      articleUrl: '',
    }))

    expect(result.status).toBe(200)
    expect(result.body.course).toMatchObject({ id: 11, episodeId: 11, category: 'indicator', contentType: 'video' })
    expect(queryRun.mock.calls[0][1][4]).toBe('indicator')
  })

  it('moves an existing course to the selected category', async () => {
    queryOne.mockResolvedValueOnce({
      episode_id: 7,
      title: '交易复盘',
      category: 'strategy',
      content_type: 'article',
      status: 'published',
    })
    queryRun.mockResolvedValueOnce({ affectedRows: 1 })

    const result = await httpPost(makeApp(), '/api/admin-course-items', coursePayload({
      episodeId: 7,
      title: '交易复盘',
      category: 'strategy',
    }))

    expect(result.status).toBe(200)
    expect(result.body.course).toMatchObject({ episodeId: 7, category: 'strategy' })
    expect(queryRun.mock.calls[0][1][3]).toBe('strategy')
    expect(queryRun.mock.calls[0][1].at(-1)).toBe(7)
  })

  it('rejects unsupported content types', async () => {
    const result = await httpPost(makeApp(), '/api/admin-course-items', coursePayload({ contentType: 'embed' }))

    expect(result).toEqual({ status: 400, body: { ok: false, error: '无效的课程类型' } })
    expect(queryRun).not.toHaveBeenCalled()
  })
})

describe('admin referral rule governance', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects unsupported plans and out-of-range rates', async () => {
    const result = await httpPut(makeApp(), '/api/admin/referrals/rules', { rules:[{ plan:'free', period:'monthly', rate_bps:12000, enabled:true }] })
    expect(result.status).toBe(400)
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('allows an explicit zero rate and records the management audit', async () => {
    queryRun.mockResolvedValue({ affectedRows:1 })
    const result = await httpPut(makeApp(), '/api/admin/referrals/rules', { rules:[{ plan:'pro', period:'yearly', rate_bps:0, enabled:false }] })
    expect(result.status).toBe(200)
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('referral_rules'), ['pro','yearly',0,0])
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action:'referral_rules_updated' }))
  })
})
