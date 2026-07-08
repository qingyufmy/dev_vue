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

import { queryAll, queryOne, queryRun } from '../../server/db.js'
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
