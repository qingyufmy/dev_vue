import { Router } from 'express'
import { adminOnly, authMiddleware } from '../middleware/auth.js'
import {
  acknowledgeWebMembershipReminder,
  getAdminMembershipExpiryNotifications,
  getPendingWebMembershipReminder,
  retryMembershipExpiryNotification,
} from '../membership-expiry-notifications.js'

const router = Router()

router.get('/membership-expiry-reminders', authMiddleware, async (req, res) => {
  try {
    const reminder = await getPendingWebMembershipReminder(req.user.id, req.query.surface)
    res.json({ ok:true, reminder })
  } catch (error) {
    console.error('[MembershipExpiry] web reminder query failed:', error.message)
    res.status(500).json({ ok:false, error:'会员到期提醒读取失败' })
  }
})

router.post('/membership-expiry-reminders/:id/read', authMiddleware, async (req, res) => {
  try {
    const read = await acknowledgeWebMembershipReminder(req.user.id, req.params.id, req.body?.surface)
    if (!read) return res.status(404).json({ ok:false, error:'提醒不存在或已经处理' })
    res.json({ ok:true })
  } catch (error) {
    console.error('[MembershipExpiry] web reminder acknowledgement failed:', error.message)
    res.status(500).json({ ok:false, error:'会员到期提醒处理失败' })
  }
})

router.get('/admin/membership-expiry-notifications', authMiddleware, adminOnly, async (req, res) => {
  try {
    const data = await getAdminMembershipExpiryNotifications({
      page:req.query.page,
      pageSize:req.query.page_size,
      channel:req.query.channel,
      status:req.query.status,
      daysBefore:req.query.days_before,
      search:req.query.search,
    })
    res.json({ ok:true, ...data })
  } catch (error) {
    console.error('[MembershipExpiry] admin notification query failed:', error.message)
    res.status(500).json({ ok:false, error:'通知记录读取失败' })
  }
})

router.post('/admin/membership-expiry-notifications/:id/retry', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await retryMembershipExpiryNotification(req.params.id)
    if (!result.ok) return res.status(409).json({ ok:false, error:'该通知已经失效或不允许重试' })
    res.json(result)
  } catch (error) {
    console.error('[MembershipExpiry] admin notification retry failed:', error.message)
    res.status(500).json({ ok:false, error:'通知重试失败' })
  }
})

export default router
