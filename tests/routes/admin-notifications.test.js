import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'http'
import { readFileSync } from 'fs'

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware:(req, res, next) => { req.user = { id:7, role:'admin' }; next() },
  adminOnly:(req, res, next) => next(),
}))
vi.mock('../../server/notification-center.js', () => ({
  NotificationError:class NotificationError extends Error { constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra) } },
  previewNotifications:vi.fn(),
  createNotificationCampaign:vi.fn(),
  listNotificationCampaigns:vi.fn(),
  getNotificationCampaignDetails:vi.fn(),
  retryFailedNotificationEmails:vi.fn(),
  cancelNotificationCampaign:vi.fn(),
}))

import {
  cancelNotificationCampaign,
  createNotificationCampaign,
  getNotificationCampaignDetails,
  listNotificationCampaigns,
  previewNotifications,
  retryFailedNotificationEmails,
} from '../../server/notification-center.js'
import router from '../../server/routes/admin-notifications.js'

function request(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({ hostname:'127.0.0.1', port:server.address().port, path, method,
        headers:{ 'Content-Type':'application/json', ...headers } }, response => {
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

describe('admin notification routes', () => {
  const app = express().use(express.json()).use('/api', router)
  beforeEach(() => vi.clearAllMocks())

  it('returns the preview contract', async () => {
    previewNotifications.mockResolvedValue({ recipientCount:2, inAppCount:2, emailReachableCount:1, emailSkippedCount:1, excludedCount:3, sample:[], token:'token' })
    const response = await request(app, 'POST', '/api/admin/notifications/preview', { recipientScope:'all', title:'标题', message:'正文' })
    expect(response).toEqual({ status:200, body:{ ok:true, preview:{ recipientCount:2, inAppCount:2, emailReachableCount:1, emailSkippedCount:1, excludedCount:3, sample:[], token:'token' } } })
  })

  it('requires and forwards idempotency keys for create/retry/cancel', async () => {
    createNotificationCampaign.mockResolvedValue({ campaign:{ id:1 }, replayed:false })
    retryFailedNotificationEmails.mockResolvedValue({ campaign:{ id:1 } })
    cancelNotificationCampaign.mockResolvedValue({ campaign:{ id:1 } })
    await request(app, 'POST', '/api/admin/notifications/campaigns', { title:'标题' }, { 'Idempotency-Key':'create-1' })
    await request(app, 'POST', '/api/admin/notifications/campaigns/1/retry-failed-email', {}, { 'Idempotency-Key':'retry-1' })
    await request(app, 'POST', '/api/admin/notifications/campaigns/1/cancel', {}, { 'Idempotency-Key':'cancel-1' })
    expect(createNotificationCampaign).toHaveBeenCalledWith(7, { title:'标题' }, expect.objectContaining({ idempotencyKey:'create-1' }))
    expect(retryFailedNotificationEmails).toHaveBeenCalledWith(7, '1', expect.objectContaining({ idempotencyKey:'retry-1' }))
    expect(cancelNotificationCampaign).toHaveBeenCalledWith(7, '1', expect.objectContaining({ idempotencyKey:'cancel-1' }))
  })

  it('returns preview details with a 409 instead of leaking an exception', async () => {
    const error = new (await import('../../server/notification-center.js')).NotificationError('recipient_count_changed', '通知范围已变化，请重新确认', 409, { preview:{ recipientCount:4, token:'new' } })
    createNotificationCampaign.mockRejectedValue(error)
    const response = await request(app, 'POST', '/api/admin/notifications/campaigns', {}, { 'Idempotency-Key':'create-2' })
    expect(response).toEqual({ status:409, body:{ ok:false, code:'recipient_count_changed', error:'通知范围已变化，请重新确认', preview:{ recipientCount:4, token:'new' } } })
  })

  it('keeps list/detail response wrappers stable', async () => {
    listNotificationCampaigns.mockResolvedValue({ campaigns:[], pagination:{ page:1, total:0 } })
    getNotificationCampaignDetails.mockResolvedValue({ campaign:{ id:1 }, deliveries:[], pagination:{ page:1, total:0 } })
    expect((await request(app, 'GET', '/api/admin/notifications/campaigns')).body).toMatchObject({ ok:true, campaigns:[], pagination:{ total:0 } })
    expect((await request(app, 'GET', '/api/admin/notifications/campaigns/1')).body).toMatchObject({ ok:true, campaign:{ id:1 }, deliveries:[] })
  })

  it('keeps the dedicated limiter on writes while history GETs stay unthrottled', () => {
    const source = readFileSync(new URL('../../server/routes/admin-notifications.js', import.meta.url), 'utf8')
    expect(source).toContain('const notificationWriteLimiter = rateLimit({')
    expect(source).toContain('max:60')
    expect(source).toMatch(/router\.post\('\/admin\/notifications\/preview', authMiddleware, adminOnly, notificationWriteLimiter/)
    expect(source).toMatch(/router\.post\('\/admin\/notifications\/campaigns', authMiddleware, adminOnly, notificationWriteLimiter/)
    expect(source).toMatch(/router\.post\('\/admin\/notifications\/campaigns\/:id\/retry-failed-email', authMiddleware, adminOnly, notificationWriteLimiter/)
    expect(source).toMatch(/router\.post\('\/admin\/notifications\/campaigns\/:id\/cancel', authMiddleware, adminOnly, notificationWriteLimiter/)
    expect(source).toMatch(/router\.get\('\/admin\/notifications\/campaigns', authMiddleware/)
    expect(source).not.toMatch(/router\.get\('\/admin\/notifications\/campaigns', notificationWriteLimiter/)
  })
})
