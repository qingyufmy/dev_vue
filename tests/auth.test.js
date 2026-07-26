import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
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
  assertBridgeEligible: vi.fn(),
  createBridgeConnectionTicket: vi.fn(async () => ({ ticket: 'ticket', expiresInSeconds: 30 })),
  createBridgeRefreshSession: vi.fn(async () => ({ refreshToken: 'refresh-token', expiresInSeconds: 7776000 })),
  useBridgeRefreshSession: vi.fn(async () => ({ user: { id: 3 }, expiresInSeconds: 7776000 })),
  revokeBridgeRefreshSession: vi.fn(async () => true),
  revokeBridgeRefreshSessions: vi.fn(async () => {}),
}))
vi.mock('../server/bridge-pairing.js', () => ({
  startBridgePairing: vi.fn(async () => ({
    deviceCode: 'device-code', userCode: 'ABCD-2345', verificationPath: '/ai/bridge/pair',
    expiresInSeconds: 600, intervalSeconds: 2,
  })),
  approveBridgePairing: vi.fn(async () => ({ approved: true })),
  consumeBridgePairing: vi.fn(async () => ({ status: 'pending' })),
}))
vi.mock('../server/bridge-ws.js', () => ({
  disconnectUserSockets:vi.fn(),
}))

import { queryOne, queryAll, queryRun, withTransaction } from '../server/db.js'
import { verifyCaptcha } from '../server/captcha.js'
import authRouter from '../server/routes/auth.js'
import {
  createBridgeRefreshSession, useBridgeRefreshSession,
  revokeBridgeRefreshSession, revokeBridgeRefreshSessions,
} from '../server/bridge-auth-session.js'
import { disconnectUserSockets } from '../server/bridge-ws.js'
import { approveBridgePairing, consumeBridgePairing, startBridgePairing } from '../server/bridge-pairing.js'

withTransaction.mockImplementation(callback => callback(async (sql, params = []) => {
  if (/^\s*SELECT/i.test(sql)) {
    const row = await queryOne(sql, params)
    return [row ? [row] : [], []]
  }
  const result = await queryRun(sql, params)
  return [{ affectedRows: result?.changes || 0, insertId: result?.insertId || 0 }, []]
}))

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
    expect(json).toMatchObject({ ok: false, error: '密码长度需为8-32位' })
  })

  it('密码超过32位返回错误', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/register', { email: 'a@b.com', password: `a1${'x'.repeat(31)}` })
    expect(json).toMatchObject({ ok: false, error: '密码长度需为8-32位' })
  })

  it('手机号注册缺少验证token', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/register', { phone: '+8613800138000', password: 'abc12345' })
    expect(json).toMatchObject({ ok: false, error: '请先完成手机验证' })
  })

  it('邮箱注册缺少验证token', async () => {
    queryAll.mockResolvedValue([])
    const { json } = await callRoute('post', '/register', { email: 'a@b.com', password: 'abc12345' })
    expect(json).toMatchObject({ ok: false, error: '请先完成邮箱验证' })
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('邮箱注册拒绝已过期的验证token', async () => {
    queryAll.mockResolvedValue([])
    queryOne.mockResolvedValueOnce(null)
    const { json } = await callRoute('post', '/register', {
      email: 'a@b.com', password: 'abc12345', verifyToken: 'expired-token',
    })
    expect(json).toMatchObject({ ok: false, error: '邮箱验证已过期，请重新验证' })
    expect(queryRun).not.toHaveBeenCalled()
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

describe('auth.js — reset password rules', () => {
  beforeEach(() => vi.clearAllMocks())

  it('新密码超过32位时在验证码校验前返回错误', async () => {
    const { json } = await callRoute('post', '/reset-password', {
      email: 'a@b.com',
      newPassword: `a1${'x'.repeat(31)}`,
      verifyToken: 'unused-token',
    })
    expect(json).toMatchObject({ ok: false, error: '新密码长度需为8-32位' })
    expect(queryOne).not.toHaveBeenCalled()
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
    expect(json).toMatchObject({ ok: true, token: 'mock-token-123', bridgeRole:'user' })
    expect(useBridgeRefreshSession).toHaveBeenCalledWith('refresh-token', expect.any(Object))
  })

  it('returns the authoritative administrator capability with a refreshed Bridge session', async () => {
    useBridgeRefreshSession.mockResolvedValueOnce({
      user:{ id:3, role:'admin', token_version:0 },
      expiresInSeconds:7776000,
    })

    const { json } = await callRoute('post', '/auth/bridge-refresh', { refreshToken:'refresh-token' })

    expect(json).toMatchObject({ ok:true, bridgeRole:'admin' })
  })

  it('returns 401 only when the device authorization was explicitly invalidated', async () => {
    useBridgeRefreshSession.mockRejectedValueOnce(Object.assign(
      new Error('revoked'), { code:'bridge_refresh_revoked' },
    ))

    const result = await callRoute('post', '/auth/bridge-refresh', { refreshToken:'revoked-token' })

    expect(result.status).toBe(401)
    expect(result.json).toMatchObject({ ok:false, code:'bridge_refresh_revoked' })
  })

  it('returns a retryable 503 without invalidating authorization on server failures', async () => {
    useBridgeRefreshSession.mockRejectedValueOnce(new Error('database offline'))

    const result = await callRoute('post', '/auth/bridge-refresh', { refreshToken:'valid-token' })

    expect(result.status).toBe(503)
    expect(result.json).toMatchObject({ ok:false, code:'bridge_refresh_unavailable' })
  })

  it('revokes only the current Bridge refresh credential on explicit logout', async () => {
    const { json } = await callRoute('post', '/auth/bridge-revoke', {
      refreshToken: 'current-device-refresh-token',
    }, { id:3, role:'user', plan:'pro' })

    expect(json).toEqual({ ok:true })
    expect(revokeBridgeRefreshSession).toHaveBeenCalledWith(3, 'current-device-refresh-token')
    expect(revokeBridgeRefreshSessions).not.toHaveBeenCalled()
  })

  it('starts, approves, and polls browser pairing without putting a refresh token in the URL', async () => {
    const started = await callRoute('post', '/auth/bridge-pair/start', { deviceName: 'Desk PC' })
    expect(started.status).toBe(201)
    expect(started.json).toMatchObject({ ok: true, verificationPath: '/ai/bridge/pair' })
    expect(startBridgePairing).toHaveBeenCalled()

    const approved = await callRoute('post', '/auth/bridge-pair/approve', { userCode: 'ABCD-2345' }, {
      id: 3, role: 'user', plan: 'pro',
    })
    expect(approved.json).toMatchObject({ ok: true, approved: true })
    expect(approveBridgePairing).toHaveBeenCalledWith(
      expect.objectContaining({ id:3 }),
      'ABCD-2345',
      expect.objectContaining({ bridgeUserId:undefined }),
    )

    const polled = await callRoute('post', '/auth/bridge-pair/token', { deviceCode: 'device-code' })
    expect(polled.status).toBe(202)
    expect(consumeBridgePairing).toHaveBeenCalled()
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

  it('only returns a verification token when the one-time code claim succeeds', async () => {
    queryOne.mockResolvedValue({ id: 19 })
    queryRun.mockResolvedValue({ changes: 0 })
    const { json } = await callRoute('post', '/verify-code', {
      email: 'a@b.com', code: '123456', purpose: 'reset',
    })
    expect(json).toMatchObject({ ok: false, error: '验证码无效或已过期' })
    expect(queryRun).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = ? AND used = 0'),
      [expect.any(String), 19]
    )
  })
})

describe('auth.js — reset-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('参数不完整', async () => {
    const { json } = await callRoute('post', '/reset-password', {})
    expect(json).toMatchObject({ ok: false, error: '参数不完整' })
  })

  it('updates the password, revokes refresh sessions and consumes the token in one transaction', async () => {
    queryOne.mockResolvedValueOnce({ id: 22 }).mockResolvedValueOnce({ id: 7 })
    queryRun.mockResolvedValue({ changes: 1 })
    const { json } = await callRoute('post', '/reset-password', {
      email: 'a@b.com', newPassword: 'newpass123', verifyToken: 'verify-token',
    })
    expect(json.ok).toBe(true)
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(revokeBridgeRefreshSessions).toHaveBeenCalledWith(7, { run: expect.any(Function) })
    expect(disconnectUserSockets).toHaveBeenCalledWith(7, 'Password reset')
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('token_used = 1'), [22])
  })
})

describe('auth.js — change-password', () => {
  beforeEach(() => vi.clearAllMocks())

  it('缺少新密码', async () => {
    const { json } = await callRoute('post', '/change-password', {}, { id: 1 })
    expect(json).toMatchObject({ ok: false, error: '参数不完整' })
  })

  it('拒绝不符合统一规则的新密码', async () => {
    const { json } = await callRoute('post', '/change-password', { newPassword:'short' }, { id:1 })
    expect(json).toMatchObject({ ok:false, error:'新密码长度需为8-32位' })
    expect(queryOne).not.toHaveBeenCalled()
  })
})

describe('auth.js — logout all devices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('increments the JWT version, revokes refresh sessions and disconnects sockets', async () => {
    queryRun.mockResolvedValue({ changes:1 })
    const { json } = await callRoute('post', '/auth/logout-all', {}, { id:7 })
    expect(json).toEqual({ ok:true })
    expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('token_version = token_version + 1'), [7])
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(revokeBridgeRefreshSessions).toHaveBeenCalledWith(7, { run: expect.any(Function) })
    expect(disconnectUserSockets).toHaveBeenCalledWith(7, 'Signed out on all devices')
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
