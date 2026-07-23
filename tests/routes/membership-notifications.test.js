import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'http'

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware:(req, res, next) => { req.user = { id:7, role:'admin' }; next() },
  adminOnly:(req, res, next) => next(),
}))
vi.mock('../../server/membership-expiry-notifications.js', () => ({
  getPendingWebMembershipReminder:vi.fn(),
  acknowledgeWebMembershipReminder:vi.fn(),
  getAdminMembershipExpiryNotifications:vi.fn(),
  retryMembershipExpiryNotification:vi.fn(),
}))

import {
  acknowledgeWebMembershipReminder,
  getAdminMembershipExpiryNotifications,
  getPendingWebMembershipReminder,
  retryMembershipExpiryNotification,
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

  it('returns filtered notification audit records to administrators', async () => {
    getAdminMembershipExpiryNotifications.mockResolvedValue({ page:2, pageSize:10, total:12, records:[] })
    const response = await request(app, 'GET', '/api/admin/membership-expiry-notifications?page=2&channel=sms&status=failed&days_before=3&search=138')
    expect(response.body).toMatchObject({ ok:true, page:2, total:12 })
    expect(getAdminMembershipExpiryNotifications).toHaveBeenCalledWith({
      page:'2', pageSize:undefined, channel:'sms', status:'failed', daysBefore:'3', search:'138',
    })
  })

  it('retries only an eligible failed delivery', async () => {
    retryMembershipExpiryNotification.mockResolvedValue({ ok:true, status:'sent', deferred:false })
    const response = await request(app, 'POST', '/api/admin/membership-expiry-notifications/18/retry')
    expect(response).toEqual({ status:200, body:{ ok:true, status:'sent', deferred:false } })
    expect(retryMembershipExpiryNotification).toHaveBeenCalledWith('18')
  })
})
