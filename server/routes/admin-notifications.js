import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import {
  NotificationError,
  previewNotifications,
  createNotificationCampaign,
  listNotificationCampaigns,
  getNotificationCampaignDetails,
  retryFailedNotificationEmails,
  cancelNotificationCampaign,
} from '../notification-center.js'

const router = Router()
// Preview is debounced in the editor, while create/cancel/retry are explicit
// writes.  Keep one bounded limiter for all four POST operations; GET history
// and detail endpoints remain unrestricted so an administrator can investigate
// a busy campaign without consuming the write budget.
const notificationWriteLimiter = rateLimit({
  windowMs:60 * 1000,
  max:60,
  standardHeaders:true,
  legacyHeaders:false,
  message:{ ok:false, code:'notification_rate_limited', error:'通知操作过于频繁，请稍后再试' },
})

function errorResponse(res, error) {
  if (error instanceof NotificationError) {
    const body = { ok:false, code:error.code || 'notification_operation_failed', error:error.message || '通知操作失败' }
    if (error.preview) body.preview = error.preview
    return res.status(Number(error.status) || 400).json(body)
  }
  console.error('[AdminNotifications]', error?.stack || error)
  return res.status(500).json({ ok:false, error:'通知服务暂时不可用，请稍后重试' })
}

router.post('/admin/notifications/preview', authMiddleware, adminOnly, notificationWriteLimiter, async (req, res) => {
  try {
    const preview = await previewNotifications(req.user.id, req.body || {})
    res.json({
      ok:true,
      preview:{
        recipientCount:preview.recipientCount,
        inAppCount:preview.inAppCount,
        emailReachableCount:preview.emailReachableCount,
        emailSkippedCount:preview.emailSkippedCount,
        excludedCount:preview.excludedCount,
        sample:preview.sample,
        token:preview.token,
      },
    })
  } catch (error) { errorResponse(res, error) }
})

router.post('/admin/notifications/campaigns', authMiddleware, adminOnly, notificationWriteLimiter, async (req, res) => {
  try {
    const key = req.get('Idempotency-Key') || req.body?.idempotencyKey || req.body?.idempotency_key
    const result = await createNotificationCampaign(req.user.id, req.body || {}, { idempotencyKey:key, request:req })
    res.json({ ok:true, campaign:result.campaign })
  } catch (error) { errorResponse(res, error) }
})

router.get('/admin/notifications/campaigns', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await listNotificationCampaigns({ page:req.query.page, pageSize:req.query.pageSize ?? req.query.page_size ?? req.query.limit, status:req.query.status })
    res.json({ ok:true, ...result })
  } catch (error) { errorResponse(res, error) }
})

router.get('/admin/notifications/campaigns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await getNotificationCampaignDetails(req.params.id, {
      page:req.query.page, pageSize:req.query.pageSize ?? req.query.page_size ?? req.query.limit, status:req.query.status,
    })
    res.json({ ok:true, ...result })
  } catch (error) { errorResponse(res, error) }
})

router.post('/admin/notifications/campaigns/:id/retry-failed-email', authMiddleware, adminOnly, notificationWriteLimiter, async (req, res) => {
  try {
    const result = await retryFailedNotificationEmails(req.user.id, req.params.id, {
      idempotencyKey:req.get('Idempotency-Key') || req.body?.idempotencyKey || req.body?.idempotency_key, request:req,
    })
    res.json({ ok:true, ...result })
  } catch (error) { errorResponse(res, error) }
})

router.post('/admin/notifications/campaigns/:id/cancel', authMiddleware, adminOnly, notificationWriteLimiter, async (req, res) => {
  try {
    const result = await cancelNotificationCampaign(req.user.id, req.params.id, {
      idempotencyKey:req.get('Idempotency-Key') || req.body?.idempotencyKey || req.body?.idempotency_key, request:req,
    })
    res.json({ ok:true, ...result })
  } catch (error) { errorResponse(res, error) }
})

export default router
