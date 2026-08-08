import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'

const JWT_SECRET = 'test-secret-key-for-testing-only'

vi.mock('../../server/config.js', () => ({
  JWT_SECRET: 'test-secret-key-for-testing-only',
  JWT_EXPIRY: '7d',
}))

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryRun: vi.fn(),
}))

import { queryOne, queryRun } from '../../server/db.js'
import { authMiddleware, optionalAuth, adminOnly, generateToken } from '../../server/middleware/auth.js'

function mockReq(authHeader) {
  return { headers: { authorization: authHeader }, user: null }
}

function mockRes() {
  const res = {}
  res._status = 200
  res._json = null
  res.status = (c) => { res._status = c; return res }
  res.json = (data) => { res._json = data; return res }
  return res
}

function mockNext() { return vi.fn() }

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no Authorization header', async () => {
    const req = mockReq(undefined)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    expect(res._status).toBe(401)
    expect(res._json.error).toBe('请先登录')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when header does not start with Bearer', async () => {
    const req = mockReq('Basic abc123')
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    expect(res._status).toBe(401)
  })

  it('returns 401 for invalid JWT token', async () => {
    const req = mockReq('Bearer invalid-token')
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    expect(res._status).toBe(401)
    expect(res._json.error).toBe('Token无效或已过期')
  })

  it('returns 401 for expired JWT token', async () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '-1h' })
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    expect(res._status).toBe(401)
  })

  it('returns 401 when user not found in DB', async () => {
    const token = jwt.sign({ userId: 999 }, JWT_SECRET, { expiresIn: '7d' })
    queryOne.mockResolvedValue(null)
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    await new Promise(r => setTimeout(r, 10))
    expect(res._status).toBe(401)
    expect(res._json.error).toBe('用户不存在')
  })

  it('sets req.user and calls next for valid token', async () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '7d' })
    const fakeUser = { id: 1, email: 'test@test.com', role: 'user', plan: 'pro', plan_expires_at: null }
    queryOne.mockResolvedValue(fakeUser)
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    await new Promise(r => setTimeout(r, 10))
    expect(next).toHaveBeenCalled()
    expect(req.user).toBeDefined()
    expect(req.user.id).toBe(1)
    expect(queryOne.mock.calls[0][0]).toContain('plan_source')
  })

  it('rejects a token issued before the user session version changed', async () => {
    const token = jwt.sign({ userId:1, tokenVersion:2 }, JWT_SECRET, { expiresIn:'7d' })
    queryOne.mockResolvedValue({ id:1, role:'user', plan:'free', token_version:3 })
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(res._status).toBe(401)
    expect(res._json.error).toContain('登录状态已失效')
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves an expired plan and exposes free effective permissions', async () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '7d' })
    const fakeUser = { id: 1, email: 'test@test.com', role: 'user', plan: 'pro', plan_expires_at: '2020-01-01 00:00:00' }
    queryOne.mockResolvedValue(fakeUser)
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    await new Promise(r => setTimeout(r, 10))
    expect(req.user.plan).toBe('pro')
    expect(req.user.plan_expires_at).toBe('2020-01-01 00:00:00')
    expect(req.user.membershipExpired).toBe(true)
    expect(req.user.effectivePlan).toBe('free')
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('does not downgrade free plan', async () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '7d' })
    const fakeUser = { id: 1, email: 'test@test.com', role: 'user', plan: 'free', plan_expires_at: null }
    queryOne.mockResolvedValue(fakeUser)
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await authMiddleware(req, res, next)
    await new Promise(r => setTimeout(r, 10))
    expect(req.user.plan).toBe('free')
    expect(req.user.membershipExpired).toBe(false)
    expect(req.user.effectivePlan).toBe('free')
    expect(queryRun).not.toHaveBeenCalled()
  })
})

describe('optionalAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls next() without setting user when no header', async () => {
    const req = mockReq(undefined)
    const res = mockRes()
    const next = mockNext()
    await optionalAuth(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(req.user).toBeNull()
  })

  it('calls next() when token is invalid', async () => {
    const req = mockReq('Bearer invalid')
    const res = mockRes()
    const next = mockNext()
    await optionalAuth(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('sets req.user for valid token', async () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '7d' })
    queryOne.mockResolvedValue({ id: 1, role: 'user', plan: 'free' })
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await optionalAuth(req, res, next)
    await new Promise(r => setTimeout(r, 10))
    expect(next).toHaveBeenCalled()
    expect(req.user).toBeDefined()
  })

  it('does not attach a user for a revoked optional token', async () => {
    const token = jwt.sign({ userId:1, tokenVersion:1 }, JWT_SECRET, { expiresIn:'7d' })
    queryOne.mockResolvedValue({ id:1, role:'user', plan:'free', token_version:2 })
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await optionalAuth(req, res, next)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(next).toHaveBeenCalled()
    expect(req.user).toBeNull()
  })

  it('calls next() even if DB query fails', async () => {
    const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '7d' })
    queryOne.mockRejectedValue(new Error('DB error'))
    const req = mockReq(`Bearer ${token}`)
    const res = mockRes()
    const next = mockNext()
    await optionalAuth(req, res, next)
    await new Promise(r => setTimeout(r, 10))
    expect(next).toHaveBeenCalled()
  })
})

describe('adminOnly', () => {
  it('returns 403 when req.user is undefined', () => {
    const req = { user: undefined }
    const res = mockRes()
    const next = mockNext()
    adminOnly(req, res, next)
    expect(res._status).toBe(403)
    expect(res._json.error).toBe('需要管理员权限')
  })

  it('returns 403 when role is not admin', () => {
    const req = { user: { role: 'user' } }
    const res = mockRes()
    const next = mockNext()
    adminOnly(req, res, next)
    expect(res._status).toBe(403)
  })

  it('calls next() for admin user', () => {
    const req = { user: { role: 'admin' } }
    const res = mockRes()
    const next = mockNext()
    adminOnly(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})

describe('generateToken', () => {
  it('returns a valid JWT string', () => {
    const token = generateToken(42, 3)
    expect(typeof token).toBe('string')
    const decoded = jwt.verify(token, JWT_SECRET)
    expect(decoded.userId).toBe(42)
    expect(decoded.tokenVersion).toBe(3)
  })

  it('token expires in 7 days', () => {
    const token = generateToken(1)
    const decoded = jwt.verify(token, JWT_SECRET)
    const expiresIn = decoded.exp - decoded.iat
    expect(expiresIn).toBe(7 * 24 * 60 * 60)
  })
})
