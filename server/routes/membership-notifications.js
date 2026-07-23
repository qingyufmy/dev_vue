import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import {
  acknowledgeWebMembershipReminder,
  getPendingWebMembershipReminder,
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

export default router
