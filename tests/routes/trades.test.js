import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
}))

// authMiddleware: only set user if not already set by test
vi.mock('../../server/middleware/auth.js', () => ({
  optionalAuth: (req, res, next) => { if (!req.user) req.user = { id: 1, role: 'user' }; next() },
  authMiddleware: (req, res, next) => { if (!req.user) req.user = { id: 1, role: 'user' }; next() },
}))

import { queryOne, queryAll, queryRun } from '../../server/db.js'
import tradesRouter from '../../server/routes/trades.js'

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

function appWithRole(role) {
  const app = express()
  app.use(express.json())
  app.use('/api', (req, res, next) => { req.user = { id: 1, role }; next() }, tradesRouter)
  return app
}

describe('trades.js — GET /trades', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回公开战绩列表', async () => {
    queryAll.mockResolvedValueOnce([{ id: 1, trade_date: '2026-05-15', symbol: 'GOLD', direction: 'long', result: 'win', entry_price: '2400', exit_price: '2420', profit_pct: '+0.83%', notes: '', screenshot_url: '' }])
    const body = await httpReq(appWithRole('user'), 'GET', '/api/trades')
    expect(body.ok).toBe(true)
    expect(body.trades[0].symbol).toBe('GOLD')
  })

  it('按 ID 查询', async () => {
    queryOne.mockResolvedValueOnce({ id: 1, trade_date: '2026-05-15', symbol: 'GOLD', direction: 'long', result: 'win', entry_price: '2400', exit_price: '2420', profit_pct: '+0.83%', notes: '', screenshot_url: '', title: 'GOLD', created_at: '2026-01-01', user_id: 1, is_public: 1 })
    const body = await httpReq(appWithRole('user'), 'GET', '/api/trades?id=1')
    expect(body.ok).toBe(true)
  })
})

describe('trades.js — POST /trades', () => {
  beforeEach(() => vi.clearAllMocks())

  it('管理员创建战绩', async () => {
    queryRun.mockResolvedValueOnce({ changes: 1, insertId: 10 })
    const body = await httpReq(appWithRole('admin'), 'POST', '/api/trades', { symbol: 'GOLD', direction: 'long' })
    expect(body.ok).toBe(true)
    expect(body.tradeId).toBe(10)
  })

  it('非管理员被拒绝', async () => {
    const body = await httpReq(appWithRole('user'), 'POST', '/api/trades', { symbol: 'GOLD' })
    expect(body.ok).toBe(false)
  })
})
