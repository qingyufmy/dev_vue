import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
}))

vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => next()),
}))

import { queryOne } from '../server/db.js'
import paymentRouter from '../server/routes/payment.js'

function callRoute(method, path, body = {}, user = { id: 1 }) {
  return new Promise((resolve) => {
    const req = { method, path, body, params: {}, query: body, user, ip: '127.0.0.1', get: () => 'test' }
    let jsonData = null
    let statusCode = 200
    const res = {
      status: (code) => { statusCode = code; return res },
      json: (data) => { jsonData = data; resolve({ json: jsonData, status: statusCode }) },
    }
    const layer = paymentRouter.stack.find(l => l.route && l.route.path === path && l.route.methods[method])
    if (!layer) { resolve({ json: null, status: 404 }); return }
    layer.handle(req, res, (err) => {
      if (err) resolve({ json: { error: err.message }, status: 500 })
    })
  })
}

describe('payment.js — GET /payment preview', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少 preview 参数返回错误', async () => {
    const { json } = await callRoute('get', '/payment', { plan: 'pro', period: 'month' })
    expect(json).toMatchObject({ ok: false, error: '缺少参数' })
  })

  it('未知套餐返回错误', async () => {
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'invalid' })
    expect(json).toMatchObject({ ok: false, error: '未知套餐' })
  })

  it('free 套餐价格为 0', async () => {
    queryOne.mockResolvedValueOnce({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'free', period: 'month' })
    expect(json.ok).toBe(true)
    expect(json.fullPrice).toBe('0.00')
    expect(json.finalAmount).toBe('0.00')
  })

  it('pro 月付正确计算价格', async () => {
    queryOne.mockResolvedValueOnce({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'pro', period: 'month' })
    expect(json.ok).toBe(true)
    expect(json.fullPrice).toBe('100.00')
    expect(json.plan).toBe('pro')
  })

  it('年付正确计算价格', async () => {
    queryOne.mockResolvedValueOnce({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'pro', period: 'yearly' })
    expect(json.ok).toBe(true)
    expect(json.fullPrice).toBe('1000.00')
    expect(json.period).toBe('year')
  })

  it('使用推荐积分抵扣', async () => {
    queryOne.mockResolvedValueOnce({ plan: 'free', plan_expires_at: null, referral_credit: 500 })
    const { json } = await callRoute('get', '/payment', {
      preview: '1', plan: 'plus', period: 'month', use_referral_credit: '1'
    })
    expect(json.ok).toBe(true)
    expect(json.referral_credit_applied_cents).toBe(500)
  })
})

describe('payment.js — POST /payment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('支付功能暂时禁用返回 503', async () => {
    const { status } = await callRoute('post', '/payment', { plan: 'pro', period: 'month' })
    expect(status).toBe(503)
  })
})
