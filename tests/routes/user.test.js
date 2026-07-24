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

import { queryAll, queryOne, queryRun } from '../../server/db.js'
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
    expect(body.user.membershipExpired).toBe(false)
    expect(body.user.effectivePlan).toBe('free')
    expect(body.user.phoneVerified).toBe(true)
    expect(body.user.emailVerified).toBe(false)
    expect(body.user.authMethod).toBe('phone')
    expect(body.user.accountCreatedAt).toBe('2026-01-02 03:04:05')
    expect(body.user.telegramBinding).toBeNull()
  })

  it('保留过期 Pro 标识但返回免费生效权限', async () => {
    queryOne.mockResolvedValueOnce({
      id: 2, uid: 'WS000002', email: 'expired@example.com', nickname: '过期用户', role: 'user',
      plan: 'pro', plan_period: 'month', plan_expires_at: '2020-01-01 23:59:59',
      phone_verified: 0, email_verified: 1, auth_method: 'email',
    })
    const body = await httpReq(makeApp(), 'GET', '/api/profile')
    expect(body.user.plan).toBe('pro')
    expect(body.user.membershipExpired).toBe(true)
    expect(body.user.effectivePlan).toBe('free')
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

describe('user referrals - GET /referrals/me', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports dollar amounts from commission instead of source order amount', async () => {
    queryOne.mockResolvedValueOnce({ referral_code:'JOIN1', referral_credit:10 })
    queryAll.mockResolvedValueOnce([
      { id:1, referred_id:2, status:'pending', amount_cents:100, commission:10, plan_label:'Pro', email:'friend@example.com' },
      { id:2, referred_id:3, status:'approved', amount_cents:29, commission:2.9, plan_label:'Plus', email:'paid@example.com' },
    ])

    const body = await httpReq(makeApp(), 'GET', '/api/referrals/me')

    expect(body.ok).toBe(true)
    expect(body.stats).toMatchObject({
      pending_credit_amount:10,
      available_credit_amount:10,
      reserved_credit_amount:0,
      used_credit_amount:0,
    })
    expect(body.stats).not.toHaveProperty('available_credit_cents')
    expect(body.recent_commissions[0].commission_amount).toBe(2.9)
    expect(body.recent_invited_users[0].credit_amount).toBe(10)
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
