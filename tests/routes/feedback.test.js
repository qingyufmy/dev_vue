import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
}))

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => { req.user = { id: 1, role: 'user', nickname: '测试', email: 'test@example.com' }; next() },
}))

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: vi.fn().mockResolvedValue({}) }) },
}))

import { queryOne, queryAll, queryRun } from '../../server/db.js'
import feedbackRouter from '../../server/routes/feedback.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', feedbackRouter)
  return app
}

function httpReq(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      const opts = { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }
      const req = http.request(opts, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => { server.close(); resolve(JSON.parse(data)) })
      })
      req.on('error', reject)
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

describe('feedback.js — POST /feedback', () => {
  beforeEach(() => vi.clearAllMocks())

  it('成功提交反馈', async () => {
    queryRun.mockResolvedValueOnce({ changes: 1, insertId: 1 })
    queryAll.mockResolvedValueOnce([])
    queryOne.mockResolvedValueOnce(null)
    const body = await httpReq(makeApp(), 'POST', '/api/feedback', {
      type: 'bug', title: '测试标题', description: '测试描述', contact: '微信'
    })
    expect(body.ok).toBe(true)
    expect(body.feedbackId).toBe(1)
  })

  it('缺少必填字段返回 400', async () => {
    const body = await httpReq(makeApp(), 'POST', '/api/feedback', { type: 'bug' })
    expect(body.ok).toBe(false)
  })

  it('无效类型返回 400', async () => {
    const body = await httpReq(makeApp(), 'POST', '/api/feedback', {
      type: 'invalid', title: '标题', description: '描述'
    })
    expect(body.ok).toBe(false)
  })
})

describe('feedback.js — GET /feedback/history', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回用户反馈历史', async () => {
    queryAll.mockResolvedValueOnce([
      { id: 1, type: 'bug', title: 'test', description: 'desc', contact: '', created_at: '2026-01-01' }
    ])
    const body = await httpReq(makeApp(), 'GET', '/api/feedback/history')
    expect(body.ok).toBe(true)
    expect(body.items).toHaveLength(1)
  })
})
