import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()
const mockQueryAll = vi.fn()
const mockWithTransaction = vi.fn()

vi.mock('../server/db.js', () => ({
  get queryOne() { return mockQueryOne },
  get queryRun() { return mockQueryRun },
  get queryAll() { return mockQueryAll },
  get withTransaction() { return mockWithTransaction },
}))

vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => next()),
  adminOnly: vi.fn((req, res, next) => next()),
}))

vi.mock('../server/crypto/wallet.js', () => ({
  deriveAddress: vi.fn(() => 'TTestAddress12345678901234567890'),
  getAddressCount: vi.fn(() => 0),
  saveAddress: vi.fn(),
  getRequiredConfirmations: vi.fn(() => 19),
  validateAddress: vi.fn(() => true),
}))

vi.mock('../server/crypto/chains/index.js', () => ({
  adapters: { ETH: {}, BSC: {}, TRON: {}, SOL: {} },
}))

vi.mock('../server/crypto/qr.js', () => ({
  generatePaymentQR: vi.fn(() => Promise.resolve('data:image/png;base64,abc')),
}))

vi.mock('../server/crypto/monitor.js', () => ({
  addWatchAddress: vi.fn(() => Promise.resolve(1)),
}))

const mockFetch = vi.fn(() => Promise.resolve({
  json: () => Promise.resolve({ price: '1.00' })
}))
vi.stubGlobal('fetch', mockFetch)

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
    const layer = paymentRouter.stack.find(l => {
      if (!l.route || !l.route.methods[method]) return false
      const routePath = l.route.path
      if (routePath === path) return true
      const routeParts = routePath.split('/')
      const pathParts = path.split('/')
      if (routeParts.length !== pathParts.length) return false
      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(':')) {
          req.params[routeParts[i].slice(1)] = pathParts[i]
        } else if (routeParts[i] !== pathParts[i]) {
          return false
        }
      }
      return true
    })
    if (!layer) { resolve({ json: null, status: 404 }); return }
    layer.handle(req, res, (err) => {
      if (err) resolve({ json: { error: err.message }, status: 500 })
    })
  })
}

describe('payment.js — GET /payment preview', () => {
  beforeEach(() => {
    mockQueryOne.mockReset()
    mockQueryRun.mockReset()
    mockQueryRun.mockImplementation((sql) => sql.trim().startsWith('SELECT')
      ? Promise.resolve([[]])
      : Promise.resolve({ insertId: 1, changes: 1 }))
    mockQueryAll.mockReset()
    mockQueryAll.mockResolvedValue([{ key: 'fixed_tron_address', value: 'TTestAddress12345678901234567890' }])
    mockWithTransaction.mockReset()
    mockWithTransaction.mockImplementation((fn) => fn(mockQueryRun))
  })

  it('缺少 preview 参数返回错误', async () => {
    const { json } = await callRoute('get', '/payment', { plan: 'pro', period: 'month' })
    expect(json).toMatchObject({ ok: false, error: '缺少参数' })
  })

  it('未知套餐返回错误', async () => {
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'invalid' })
    expect(json).toMatchObject({ ok: false, error: '未知套餐' })
  })

  it('free 套餐价格为 0', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'free', period: 'month' })
    expect(json.ok).toBe(true)
    expect(json.fullPrice).toBe('0.00')
    expect(json.finalAmount).toBe('0.00')
  })

  it('pro 月付正确计算价格', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'pro', period: 'month' })
    expect(json.ok).toBe(true)
    expect(json.fullPrice).toBe('100.00')
    expect(json.plan).toBe('pro')
  })

  it.each(['plus', 'pro'])('过期会员可以重新购买 %s', async (targetPlan) => {
    mockQueryOne.mockResolvedValue({ plan: 'pro', plan_expires_at: '2020-01-01 23:59:59', referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: targetPlan, period: 'month' })
    expect(json.ok).toBe(true)
    expect(json.plan).toBe(targetPlan)
  })

  it('年付正确计算价格', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('get', '/payment', { preview: '1', plan: 'pro', period: 'yearly' })
    expect(json.ok).toBe(true)
    expect(json.fullPrice).toBe('1000.00')
    expect(json.period).toBe('year')
  })

  it('使用推荐积分抵扣', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 5 })
    const { json } = await callRoute('get', '/payment', {
      preview: '1', plan: 'plus', period: 'month', use_referral_credit: '1'
    })
    expect(json.ok).toBe(true)
    expect(json.referral_credit_applied).toBe(5)
  })
})

describe('payment.js — POST /payment', () => {
  beforeEach(() => {
    mockQueryOne.mockReset()
    mockQueryRun.mockReset()
    mockQueryAll.mockReset()
    mockQueryAll.mockResolvedValue([{ key: 'fixed_tron_address', value: 'TTestAddress12345678901234567890' }])
    mockWithTransaction.mockReset()
    mockQueryRun.mockImplementation((sql) => sql.trim().startsWith('SELECT')
      ? Promise.resolve([[]])
      : Promise.resolve({ insertId: 1, changes: 1 }))
    mockWithTransaction.mockImplementation((fn) => fn(mockQueryRun))
  })

  it('未知套餐返回错误', async () => {
    const { json } = await callRoute('post', '/payment', { plan: 'invalid', period: 'month', crypto_chain: 'TRON' })
    expect(json).toMatchObject({ ok: false, error: '未知套餐' })
  })

  it('缺少 crypto_chain 返回错误', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('post', '/payment', { plan: 'pro', period: 'month' })
    expect(json).toMatchObject({ ok: false, error: '不支持的支付链' })
  })

  it('不支持的链返回错误', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('post', '/payment', { plan: 'pro', period: 'month', crypto_chain: 'BTC' })
    expect(json).toMatchObject({ ok: false, error: '不支持的支付链' })
  })

  it('全额积分抵扣直接支付成功', async () => {
    const userObj = { plan: 'free', plan_expires_at: null, referral_credit: 2900 }
    mockQueryOne.mockImplementation((sql) => {
      if (sql.includes('referrals')) return Promise.resolve(null)
      if (sql.includes('existing') || sql.includes('crypto_expires_at')) return Promise.resolve(null)
      return Promise.resolve(userObj)
    })
    const { json } = await callRoute('post', '/payment', {
      plan: 'plus', period: 'month', crypto_chain: 'TRON', use_referral_credit: 1
    })
    expect(json.ok).toBe(true)
    expect(json.paid_with_credit).toBe(true)
    expect(json.orderNo).toBeDefined()
  })

  it('创建加密订单返回支付信息', async () => {
    mockQueryOne.mockImplementation((sql) => {
      if (sql.includes('crypto_expires_at')) return Promise.resolve(null)
      return Promise.resolve({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    })
    const { json } = await callRoute('post', '/payment', {
      plan: 'pro', period: 'month', crypto_chain: 'TRON'
    })
    expect(json.ok).toBe(true)
    expect(json.orderNo).toBeDefined()
    expect(json.orderId).toBeDefined()
    expect(json.crypto_chain).toBe('TRON')
    expect(json.crypto_address).toBe('TTestAddress12345678901234567890')
    expect(json.crypto_amount).toBeGreaterThan(0)
    expect(json.expires_at).toBeDefined()
    expect(json.qr_code).toBeDefined()
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO crypto_watch_list'),
      expect.arrayContaining(['TRON', 'TTestAddress12345678901234567890', 19])
    )
  })

  it('拒绝 ETH 链创建订单', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('post', '/payment', {
      plan: 'plus', period: 'month', crypto_chain: 'ETH'
    })
    expect(json.ok).toBe(false)
  })

  it('拒绝 SOL 链创建订单', async () => {
    mockQueryOne.mockResolvedValue({ plan: 'free', plan_expires_at: null, referral_credit: 0 })
    const { json } = await callRoute('post', '/payment', {
      plan: 'plus', period: 'yearly', crypto_chain: 'SOL'
    })
    expect(json.ok).toBe(false)
  })
})

describe('payment.js — GET /payment/status/:orderId', () => {
  beforeEach(() => {
    mockQueryOne.mockReset()
    mockQueryRun.mockReset()
    mockQueryAll.mockReset()
    mockQueryAll.mockResolvedValue([{ key: 'fixed_tron_address', value: 'TTestAddress12345678901234567890' }])
    mockWithTransaction.mockReset()
    mockWithTransaction.mockImplementation((fn) => fn(async (sql, params) => ({ insertId: 1 })))
  })

  it('查询存在的订单', async () => {
    mockQueryOne.mockResolvedValue({
      order_id: 'abc-123', order_no: 'WSS123', plan: 'pro', period: 'month',
      amount: 10000, status: 'pending', status_label: '待支付',
      crypto_chain: 'TRON', crypto_address: 'TAddr', crypto_amount: 100,
      crypto_expires_at: '2026-01-01 00:30:00', paid_at: null,
      confirmations: 0, required_confirmations: 19, tx_hash: null
    })
    const { json } = await callRoute('get', '/payment/status/abc-123', {}, { id: 1 })
    expect(json.ok).toBe(true)
    expect(json.status).toBe('pending')
    expect(json.confirmations).toBe(0)
  })

  it('订单不存在返回错误', async () => {
    mockQueryOne.mockResolvedValue(null)
    const { json } = await callRoute('get', '/payment/status/not-found', {}, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '订单不存在' })
  })

  it('查询已支付订单返回 paid 状态', async () => {
    mockQueryOne.mockResolvedValue({
      order_id: 'paid-001', order_no: 'WSS456', plan: 'plus', period: 'month',
      amount: 2900, status: 'paid', status_label: '已完成',
      crypto_chain: 'ETH', crypto_address: '0xAddr', crypto_amount: 2.9,
      crypto_expires_at: '2026-01-01 00:30:00', paid_at: '2026-01-01 00:15:00',
      confirmations: 12, required_confirmations: 12, tx_hash: '0xabc'
    })
    const { json } = await callRoute('get', '/payment/status/paid-001', {}, { id: 1 })
    expect(json.ok).toBe(true)
    expect(json.status).toBe('paid')
  })
})
