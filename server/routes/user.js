import { Router } from 'express'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()

router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne(`
      SELECT id, uid, email, nickname, avatar, role, plan, plan_period, plan_expires_at,
             referral_code, referral_credit, telegram_id, telegram_username, telegram_name,
             telegram_chat_id, telegram_group_status, telegram_bot_started_at,
             telegram_joined_at, telegram_last_invite_sent_at, created_at, last_seen_at
      FROM users WHERE id = ?
    `, [req.user.id])

    user.name = user.nickname
    user.isAdmin = user.role === 'admin'
    user.telegramBinding = user.telegram_id || user.telegram_username ? {
      username: user.telegram_username || '',
      name: user.telegram_name || '',
      groupStatus: user.telegram_group_status || '',
      botStartedAt: user.telegram_bot_started_at || '',
      joinedAt: user.telegram_joined_at || '',
      lastInviteSentAt: user.telegram_last_invite_sent_at || '',
    } : null

    // camelCase aliases for frontend
    user.planExpiresAt = user.plan_expires_at || ''
    user.planPeriod = user.plan_period || ''
    user.createdAt = user.created_at || ''
    user.lastSeenAt = user.last_seen_at || ''

    res.json({ ok: true, user })
  } catch (err) {
    res.json({ ok: false, error: '获取资料失败' })
  }
})

router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { nickname, name, avatar } = req.body

    const displayName = name || nickname
    if (displayName !== undefined) {
      await queryRun("UPDATE users SET nickname = ?, updated_at = NOW() WHERE id = ?", [displayName, req.user.id])
    }
    if (avatar !== undefined) {
      await queryRun("UPDATE users SET avatar = ?, updated_at = NOW() WHERE id = ?", [avatar, req.user.id])
    }

    const user = await queryOne(`
      SELECT id, uid, email, nickname, avatar, role, plan, plan_period, plan_expires_at,
             referral_code, referral_credit, telegram_id, telegram_username, telegram_name,
             telegram_group_status, telegram_bot_started_at, telegram_joined_at,
             telegram_last_invite_sent_at, created_at
      FROM users WHERE id = ?
    `, [req.user.id])

    user.name = user.nickname
    user.isAdmin = user.role === 'admin'
    user.telegramBinding = user.telegram_id || user.telegram_username ? {
      username: user.telegram_username || '',
      name: user.telegram_name || '',
      groupStatus: user.telegram_group_status || '',
    } : null

    res.json({ ok: true, user })
  } catch (err) {
    res.json({ ok: false, error: '更新资料失败' })
  }
})

router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const { limit = 20 } = req.query
    const notifications = await queryAll(`
      SELECT n.*, u.nickname as actor_name, u.avatar as actor_avatar
      FROM notifications n LEFT JOIN users u ON n.actor_id = u.id
      WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ?
    `, [req.user.id, Number(limit)])

    const countRow = await queryOne('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id])
    const unreadCount = countRow.c

    res.json({
      ok: true,
      unreadCount,
      notifications: notifications.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        postId: n.post_id,
        isRead: !!n.is_read,
        meta: typeof n.meta === 'string' ? JSON.parse(n.meta || '{}') : n.meta,
        actor: n.actor_id ? { name: n.actor_name, avatar: n.actor_avatar } : null,
        createdAt: n.created_at,
      }))
    })
  } catch (err) {
    res.json({ ok: false, error: '获取通知失败' })
  }
})

router.patch('/notifications', authMiddleware, async (req, res) => {
  try {
    const { markAll, id } = req.body

    if (markAll) {
      await queryRun('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.user.id])
    } else if (id) {
      await queryRun('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, req.user.id])
    }

    const countRow = await queryOne('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id])
    const unreadCount = countRow.c
    res.json({ ok: true, unreadCount })
  } catch (err) {
    res.json({ ok: false, error: '操作失败' })
  }
})

router.patch('/notifications', authMiddleware, async (req, res) => {
  try {
    const progress = await queryAll('SELECT * FROM progress WHERE user_id = ?', [req.user.id])
    res.json({ ok: true, progress })
  } catch (err) { res.json({ ok: false, error: '获取进度失败' }) }
})

router.post('/progress', authMiddleware, async (req, res) => {
  try {
    const { episodeId, watchedSeconds, totalDuration, completed, quizPassed } = req.body

    const existing = await queryOne('SELECT id FROM progress WHERE user_id = ? AND episode_id = ?', [req.user.id, episodeId])

    if (existing) {
      const updates = []
      const params = []
      if (watchedSeconds !== undefined) { updates.push('watched_seconds = ?'); params.push(watchedSeconds) }
      if (totalDuration !== undefined) { updates.push('total_duration = ?'); params.push(totalDuration) }
      if (completed !== undefined) { updates.push('completed = ?'); params.push(completed ? 1 : 0) }
      if (quizPassed !== undefined) { updates.push('quiz_passed = ?'); params.push(quizPassed ? 1 : 0) }
      updates.push("updated_at = NOW()")
      params.push(req.user.id, episodeId)
      await queryRun(`UPDATE progress SET ${updates.join(', ')} WHERE user_id = ? AND episode_id = ?`, params)
    } else {
      await queryRun(`
        INSERT INTO progress (user_id, episode_id, watched_seconds, total_duration, completed, quiz_passed)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [req.user.id, episodeId, watchedSeconds || 0, totalDuration || 0, completed ? 1 : 0, quizPassed ? 1 : 0])
    }

    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '更新进度失败' }) }
})

// Orders
router.get('/orders', authMiddleware, async (req, res) => {
  try {
    const { uid } = req.query
    let userId = req.user.id

    // Admin can view any user's orders
    if (uid) {
      if (req.user.role !== 'admin') return res.json({ ok: false, error: '需要管理员权限' })
      const user = await queryOne('SELECT id FROM users WHERE uid = ?', [uid])
      if (user) userId = user.id
    }

    const orders = await queryAll('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [userId])

    const statusLabels = { paid: '已完成', pending: '待支付', processing: '处理中', expired: '已过期' }
    const planLabels = { free: '免费版', plus: 'Plus', pro: 'Pro', premium: '高级版' }
    const periodLabels = { month: '月付', year: '年付', lifetime: '终身' }

    res.json({
      ok: true,
      orders: orders.map(o => ({
        orderId: o.order_id || o.order_no,
        plan: o.plan,
        planLabel: planLabels[o.plan] || o.plan_label || o.plan,
        period: o.period,
        periodLabel: periodLabels[o.period] || o.period_label || o.period,
        amount: o.amount,
        amountConfirmed: o.amount_confirmed || o.amount,
        status: o.status,
        statusLabel: statusLabels[o.status] || o.status_label || o.status,
        paidAt: o.paid_at,
        createdAt: o.created_at,
      }))
    })
  } catch (err) { res.json({ ok: false, error: '获取订单失败' }) }
})

// Referrals
router.get('/referrals/me', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT referral_code, referral_credit FROM users WHERE id = ?', [req.user.id])
    const referrals = await queryAll(`
      SELECT r.*, u.nickname, u.email FROM referrals r
      LEFT JOIN users u ON r.referred_id = u.id WHERE r.referrer_id = ? ORDER BY r.created_at DESC
    `, [req.user.id])

    const baseUrl = req.protocol + '://' + req.get('host')
    const referralLink = `${baseUrl}/?ref=${user.referral_code}`

    const invitedCount = referrals.length
    const paidCount = referrals.filter(r => r.status === 'approved').length
    const pendingCredit = referrals.filter(r => r.status === 'pending').reduce((s, r) => s + (r.amount_cents || 0), 0)
    const availableCredit = user.referral_credit || 0

    res.json({
      ok: true,
      referral_code: user.referral_code,
      referral_link: referralLink,
      disabled: false,
      stats: {
        invited_count: invitedCount,
        paid_invited_count: paidCount,
        pending_credit_cents: pendingCredit,
        available_credit_cents: availableCredit,
        reserved_credit_cents: 0,
        used_credit_cents: 0,
      },
      recent_commissions: referrals.filter(r => r.status === 'approved').slice(0, 5).map(r => ({
        plan_label: r.plan_label || 'Plus',
        amount_cents: r.amount_cents || 500,
        status: r.status,
        status_label: '已确认',
        created_at: r.created_at,
        invited_user: { email_masked: (r.email || '').replace(/(.{2}).*(@.*)/, '$1***$2') },
      })),
      recent_invited_users: referrals.slice(0, 10).map(r => ({
        uid: r.referred_id,
        email_masked: (r.email || '').replace(/(.{2}).*(@.*)/, '$1***$2'),
        paid: r.status === 'approved',
        credit_cents: r.amount_cents || 0,
        attributed_at: r.attributed_at || r.created_at,
      })),
    })
  } catch (err) { res.json({ ok: false, error: '获取推荐信息失败' }) }
})

router.get('/referrals/track', (req, res) => {
  try {
    res.json({ ok: true, referralCode: 'WSS' + String(req.user?.id || 0).padStart(4, '0') })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/referrals/track', async (req, res) => {
  try {
    const { code } = req.body || {}
    if (!code) return res.json({ ok: false, error: '缺少邀请码' })
    const inviter = await queryOne('SELECT id, nickname FROM users WHERE referral_code = ?', [code])
    if (inviter) {
      res.json({ ok: true, inviter: inviter.nickname || inviter.email })
    } else {
      res.json({ ok: false, error: '邀请码无效' })
    }
  } catch (err) { res.json({ ok: false, error: '查询失败' }) }
})

export default router
