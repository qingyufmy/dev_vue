import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware:(req, res, next) => { req.user = { id:7 }; next() },
}))
vi.mock('../../server/membership-expiry-notifications.js', () => ({
  getPendingWebMembershipReminder:vi.fn(),
  acknowledgeWebMembershipReminder:vi.fn(),
}))

import {
  acknowledgeWebMembershipReminder,
  getPendingWebMembershipReminder,
} from '../../server/membership-expiry-notifications.js'
import router from '../../server/routes/membership-notifications.js'

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({
        hostname:'127.0.0.1', port:server.address().port, path, method,
        headers:{ 'Content-Type':'application/json' },
      }, res => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => { server.close(); resolve({ status:res.statusCode, body:JSON.parse(text) }) })
      })
      req.on('error', reject)
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

describe('membership notification routes', () => {
  const app = express().use(express.json()).use('/api', router)
  beforeEach(() => vi.clearAllMocks())

  it('loads the surface-specific reminder', async () => {
    getPendingWebMembershipReminder.mockResolvedValue({ id:3, days_before:2 })
    const response = await request(app, 'GET', '/api/membership-expiry-reminders?surface=ai')
    expect(response).toEqual({ status:200, body:{ ok:true, reminder:{ id:3, days_before:2 } } })
    expect(getPendingWebMembershipReminder).toHaveBeenCalledWith(7, 'ai')
  })

  it('acknowledges only the current user reminder', async () => {
    acknowledgeWebMembershipReminder.mockResolvedValue(true)
    const response = await request(app, 'POST', '/api/membership-expiry-reminders/3/read', { surface:'main' })
    expect(response.body.ok).toBe(true)
    expect(acknowledgeWebMembershipReminder).toHaveBeenCalledWith(7, '3', 'main')
  })
})
