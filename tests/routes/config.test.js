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
    req.user = { id: 1, role: 'admin' }
    next()
  },
  adminOnly: (req, res, next) => next(),
}))

vi.mock('../../server/crypto/fixed-address.js', () => ({
  resetFixedAddressCache: vi.fn(),
}))

vi.mock('../../server/sms.js', () => ({
  resetSmsConfigCache:vi.fn(),
  loadSmsConfig:vi.fn(),
  sendSms:vi.fn(),
}))

import { queryAll, queryOne, queryRun } from '../../server/db.js'
import { loadSmsConfig, sendSms } from '../../server/sms.js'
import configRouter from '../../server/routes/config.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', configRouter)
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

describe('config.js — GET /system-config-public/:category', () => {
  beforeEach(() => vi.clearAllMocks())

  it('公开类别返回配置', async () => {
    queryAll.mockResolvedValueOnce([{ key: 'items', value: '[]', category: 'toolbox' }])
    const body = await httpReq(makeApp(), 'GET', '/api/system-config-public/toolbox')
    expect(body.ok).toBe(true)
    expect(body.items).toHaveLength(1)
  })

  it('非公开类别返回 403', async () => {
    // express doesn't auto-set status in our test helper, check error message
    const body = await httpReq(makeApp(), 'GET', '/api/system-config-public/smtp')
    expect(body.error).toBe('Forbidden')
  })
})

describe('config.js — GET /changelog/current', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回当前版本号和内容', async () => {
    queryOne
      .mockResolvedValueOnce({ value: '5' })
      .mockResolvedValueOnce({ value: '更新内容' })
    const body = await httpReq(makeApp(), 'GET', '/api/changelog/current')
    expect(body.ok).toBe(true)
    expect(body.version).toBe(5)
    expect(body.content).toBe('更新内容')
  })

  it('无配置时返回默认值', async () => {
    queryOne.mockResolvedValue(null)
    const body = await httpReq(makeApp(), 'GET', '/api/changelog/current')
    expect(body.ok).toBe(true)
    expect(body.version).toBe(1)
    expect(body.content).toBe('')
  })
})

describe('config.js — membership expiry SMS test', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the approved membership template parameters', async () => {
    loadSmsConfig.mockResolvedValue({
      accessKeyId:'key', accessKeySecret:'secret', signName:'量见',
      templateCodes:{ membership_expiry:'SMS_EXPIRY' },
    })
    sendSms.mockResolvedValue({ code:'OK' })
    const body = await httpReq(makeApp(), 'POST', '/api/system-config/sms/test', {
      to:'13800138000', template:'membership_expiry',
    })
    expect(body.ok).toBe(true)
    expect(sendSms).toHaveBeenCalledWith('13800138000', 'SMS_EXPIRY', {
      plan:'Pro', expire_date:'2026-07-30', days:'7',
    })
  })

  it('uses a separate expired-membership template without a days parameter', async () => {
    loadSmsConfig.mockResolvedValue({
      accessKeyId:'key', accessKeySecret:'secret', signName:'量见',
      templateCodes:{ membership_expired:'SMS_EXPIRED' },
    })
    sendSms.mockResolvedValue({ code:'OK' })
    const body = await httpReq(makeApp(), 'POST', '/api/system-config/sms/test', {
      to:'13800138000', template:'membership_expired',
    })
    expect(body.ok).toBe(true)
    expect(sendSms).toHaveBeenCalledWith('13800138000', 'SMS_EXPIRED', {
      plan:'Pro', expire_date:'2026-07-30',
    })
  })
})
