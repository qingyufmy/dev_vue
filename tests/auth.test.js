import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  logAudit: vi.fn(),
}))
vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, res, next) => next()),
  generateToken: vi.fn(() => 'mock-token-123'),
}))
vi.mock('../server/sms.js', () => ({
  sendVerificationSms: vi.fn(),
}))
vi.mock('../server/captcha.js', () => ({
  generateCaptcha: vi.fn(() => ({ id: 'cap-1', svg: '<svg/>' })),
  verifyCaptcha: vi.fn(() => true),
}))
vi.mock('../server/bridge-auth-session.js', () => ({
  createBridgeRefreshSession: vi.fn(async () => ({ refreshToken: 'refresh-token', expiresInSeconds: 7776000 })),
  useBridgeRefreshSession: vi.fn(async () => ({ user: { id: 3 }, expiresInSeconds: 7776000 })),
  revokeBridgeRefreshSessions: vi.fn(async () => {}),
}))

import { queryOne, queryAll, queryRun } from '../server/db.js'
import { verifyCaptcha } from '../server/captcha.js'
import authRouter from '../server/routes/auth.js'
import { createBridgeRefreshSession, useBridgeRefreshSession } from '../server/bridge-auth-session.js'

function callRoute(method, path, body = {}, user = null) {
  return new Promise((resolve) => {
    const req = { method, path, body, params: {}, query: body, user, ip: '127.0.0.1', get: () => 'test' }
    let jsonData = null, statusCode = 200
    const res = {
      status: (c) => { statusCode = c; return res },
      json: (d) => { jsonData = d; resolve({ json: jsonData, status: statusCode }) },
    }
    const layer = authRouter.stack.find(l => l.route && l.route.path === path && l.route.methods[method])
    if (!layer) { resolve({ json: null, status: 404 }); return }
    layer.handle(req, res, (err) => { if (err) resolve({ json: { error: err.message }, status: 500 }) })
  })
}

describe('auth.js — register', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少邮箱返回错误', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/register', {})
    expect(json).toMatchObject({ ok: false, error: '邮箱和密码不能为空' })
  })

  it('密码太短返回错误', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/register', { email: 'a@b.com', password: '123' })
    expect(json).toMatchObject({ ok: false, error: '密码至少8位' })
  })

  it('手机号注册缺少验证token', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/register', { phone: '+8613800138000', password: 'abc12345' })
    expect(json).toMatchObject({ ok: false, error: '请先完成手机验证' })
  })
})

describe('auth.js — login', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少账号返回错误', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/login', {})
    expect(json).toMatchObject({ ok: false, error: '请输入邮箱或手机号' })
  })

  it('不支持的登录方式', async () => {
    queryAll.mockResolvedValue([])
    queryOne.mockResolvedValue({ id: 1, password: '$2a$10$x' })
    const { json } = await callRoute('post', '/login', { email: 'a@b.com', method: 'bad' })
    expect(json).toMatchObject({ ok: false, error: '不支持的登录方式' })
  })

  it('验证码登录缺少token', async () => {
    queryAll.mockResolvedValue([])
    queryOne.mockResolvedValue({ id: 1, password: '$2a$10$x' })
    const { json } = await callRoute('post', '/login', { email: 'a@b.com', method: 'code' })
    expect(json).toMatchObject({ ok: false, error: '请先完成验证' })
  })
})

describe('auth.js — Bridge sessions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('bootstraps a refresh credential from a still-valid access token', async () => {
    const { json } = await callRoute('post', '/auth/bridge-session', {}, {
      id: 3, role: 'user', plan: 'pro', plan_expires_at: null,
    })
    expect(json).toMatchObject({ ok: true, refreshToken: 'refresh-token' })
    expect(createBridgeRefreshSession).toHaveBeenCalled()
  })

  it('returns a new short-lived token for a valid refresh credential', async () => {
    const { json } = await callRoute('post', '/auth/bridge-refresh', { refreshToken: 'refresh-token' })
    expect(json).toMatchObject({ ok: true, token: 'mock-token-123' })
    expect(useBridgeRefreshSession).toHaveBeenCalledWith('refresh-token', expect.any(Object))
  })
})

describe('auth.js — send-code', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少目标返回错误', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/send-code', {})
    expect(json).toMatchObject({ ok: false, error: '请输入邮箱或手机号' })
  })

  it('手机号需要图形验证码', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/send-code', { phone: '+8613800138000' })
    expect(json).toMatchObject({ ok: false, error: '请输入图形验证码' })
  })

  it('图形验证码错误', async () => {
    queryAll.mockResolvedValue([])
    verifyCaptcha.mockReturnValueOnce(false)
    const { json } = await callRoute('post', '/send-code', {
      phone: '+8613800138000', captchaId: 'c', captchaAnswer: 'x'
    })
    expect(json).toMatchObject({ ok: false, error: '图形验证码错误' })
  })
})

describe('auth.js — verify-code', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少目标返回错误', async () => {
    const { json } = await callRoute('post', '/verify-code', {})
    expect(json).toMatchObject({ ok: false, error: '请输入邮箱或手机号' })
  })
})

describe('auth.js — reset-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('参数不完整', async () => {
    const { json } = await callRoute('post', '/reset-password', {})
    expect(json).toMatchObject({ ok: false, error: '参数不完整' })
  })
})

describe('auth.js — change-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少新密码', async () => {
    const { json } = await callRoute('post', '/change-password', {}, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '参数不完整' })
  })
})

describe('auth.js — auth-methods', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回默认开关状态', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('get', '/auth-methods', {})
    expect(json.ok).toBe(true)
    expect(json.emailEnabled).toBe(true)
    expect(json.phoneEnabled).toBe(true)
  })
})

describe('auth.js — captcha', () => {
  it('返回验证码', async () => {
    const { json } = await callRoute('get', '/captcha', {})
    expect(json.ok).toBe(true)
    expect(json.id).toBe('cap-1')
    expect(json.svg).toContain('<svg')
  })
})
