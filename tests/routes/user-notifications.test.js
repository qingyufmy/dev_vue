import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'http'

const { queryOne, queryAll, queryRun } = vi.hoisted(() => ({ queryOne:vi.fn(), queryAll:vi.fn(), queryRun:vi.fn() }))

vi.mock('../../server/db.js', () => ({ queryOne, queryAll, queryRun }))
vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware:(req, res, next) => { req.user = { id:42, role:'user' }; next() },
}))
vi.mock('../../server/membership.js', () => ({ decorateMembership:user => user }))

import router from '../../server/routes/user.js'

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ hostname:'127.0.0.1', port:server.address().port, path, method, headers:{ 'Content-Type':'application/json' } }, response => {
        let text = ''
        response.on('data', chunk => { text += chunk })
        response.on('end', () => { server.close(); resolve({ status:response.statusCode, body:JSON.parse(text) }) })
      })
      req.on('error', reject)
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

describe('user notification API', () => {
  const app = express().use(express.json()).use('/api', router)
  beforeEach(() => { vi.clearAllMocks(); queryRun.mockResolvedValue({ changes:1 }); queryAll.mockResolvedValue([]) })

  it('returns cursor items with priority/link/read/ack state', async () => {
    queryAll.mockResolvedValue([{ id:9, type:'system', title:'标题', message:'正文', link:'/account/', priority:'important', requires_ack:1, is_read:0, read_at:null, acknowledged_at:null, created_at:'2026-08-10 10:00:00' }])
    queryOne.mockResolvedValue({ c:1 })
    const response = await request(app, 'GET', '/api/notifications?limit=20')
    expect(response.status).toBe(200)
    expect(response.body.notifications[0]).toMatchObject({ id:9, link:'/account/', priority:'important', requiresAck:true, readAt:null, acknowledgedAt:null })
    expect(response.body.nextCursor).toBe(null)
  })

  it('binds bulk read and acknowledgement updates to the authenticated user', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT id, requires_ack')) return { id:9, requires_ack:1, acknowledged_at:null }
      if (sql.includes('COUNT(*) AS c')) return { c:0 }
      if (sql.includes('SELECT id, title')) return { id:9, title:'标题', message:'正文', priority:'important', requires_ack:1, is_read:1, read_at:'2026-08-10 10:00:00', acknowledged_at:'2026-08-10 10:00:00', created_at:'2026-08-10 09:00:00' }
      return null
    })
    const readResponse = await request(app, 'PATCH', '/api/notifications', { markAll:true })
    const ackResponse = await request(app, 'POST', '/api/notifications/9/acknowledge', {})
    expect(readResponse.body).toMatchObject({ ok:true })
    expect(ackResponse.body.notification).toMatchObject({ id:9, requiresAck:true, acknowledgedAt:'2026-08-10 10:00:00' })
    expect(queryRun.mock.calls.some(([sql, params]) => sql.includes('WHERE id = ? AND user_id = ?') && params.includes(42))).toBe(true)
  })
})
