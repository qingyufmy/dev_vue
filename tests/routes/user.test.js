import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
}))

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    req.user = { id: 1, role: 'user', plan: 'free' }
    next()
  },
}))

import { queryOne, queryRun } from '../../server/db.js'
import userRouter from '../../server/routes/user.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', userRouter)
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

describe('user.js — GET /profile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回用户资料（camelCase）', async () => {
    queryOne.mockResolvedValueOnce({
      id: 1, uid: 'WS000001', email: 'test@example.com', phone: '13800138000',
      nickname: '测试用户', avatar: '', role: 'user', plan: 'free', plan_period: '',
      plan_expires_at: '', phone_verified: 1, email_verified: 0, auth_method: 'phone',
      telegram_id: null, telegram_username: null, telegram_name: null, created_at: '2026-01-02 03:04:05',
    })

    const body = await httpReq(makeApp(), 'GET', '/api/profile')
    expect(body.ok).toBe(true)
    expect(body.user.name).toBe('测试用户')
    expect(body.user.plan).toBe('free')
    expect(body.user.phoneVerified).toBe(true)
    expect(body.user.emailVerified).toBe(false)
    expect(body.user.authMethod).toBe('phone')
    expect(body.user.accountCreatedAt).toBe('2026-01-02 03:04:05')
    expect(body.user.telegramBinding).toBeNull()
  })

  it('有 Telegram 绑定时返回绑定信息', async () => {
    queryOne.mockResolvedValueOnce({
      id: 1, uid: 'WS000001', email: null, phone: null,
      nickname: '', avatar: '', role: 'user', plan: 'free', plan_period: '',
      plan_expires_at: '', phone_verified: 0, email_verified: 0, auth_method: 'email',
      telegram_id: '12345', telegram_username: 'testbot', telegram_name: 'Test',
    })

    const body = await httpReq(makeApp(), 'GET', '/api/profile')
    expect(body.user.telegramBinding).toEqual({ username: 'testbot', name: 'Test' })
  })
})

describe('user.js — PUT /profile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('更新昵称', async () => {
    queryRun.mockResolvedValue({ changes: 1 })
    queryOne.mockResolvedValueOnce({
      id: 1, uid: 'WS000001', email: null, phone: null,
      nickname: '新昵称', avatar: '', role: 'user', plan: 'free', plan_period: '',
      plan_expires_at: '', phone_verified: 0, email_verified: 0, auth_method: 'email',
      telegram_id: null, telegram_username: null, telegram_name: null,
    })

    const body = await httpReq(makeApp(), 'PUT', '/api/profile', { name: '新昵称' })
    expect(body.ok).toBe(true)
    expect(body.user.name).toBe('新昵称')
  })
})
