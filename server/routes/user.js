import { Router } from 'express'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { decorateMembership } from '../membership.js'

const router = Router()

router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const row = await queryOne(`
      SELECT id, uid, email, phone, nickname, avatar, role, plan, plan_period, plan_expires_at, plan_source,
             phone_verified, email_verified, auth_method,
             telegram_id, telegram_username, telegram_name, created_at
      FROM users WHERE id = ?
    `, [req.user.id])

    if (!row) return res.status(404).json({ ok: false, error: '用户不存在' })

    const membership = decorateMembership(row)
    const user = {
      id: row.id,
      uid: row.uid,
      email: row.email,
      phone: row.phone,
      name: row.nickname,
      avatar: row.avatar,
      role: row.role,
      isAdmin: row.role === 'admin',
      plan: row.plan,
      planPeriod: row.plan_period || '',
      planExpiresAt: row.plan_expires_at || '',
      planSource: row.plan_source || null,
      membershipExpired: membership.membershipExpired,
      effectivePlan: membership.effectivePlan,
      accountCreatedAt: row.created_at || '',
      phoneVerified: !!row.phone_verified,
      emailVerified: !!row.email_verified,
      authMethod: row.auth_method || 'email',
      telegramBinding: row.telegram_id || row.telegram_username ? {
        username: row.telegram_username || '',
        name: row.telegram_name || '',
      } : null,
    }

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
             telegram_last_invite_sent_at, created_at,
             phone, phone_verified, email_verified, auth_method
      FROM users WHERE id = ?
    `, [req.user.id])

    const membership = decorateMembership(user)
    user.membershipExpired = membership.membershipExpired
    user.effectivePlan = membership.effectivePlan
    user.name = user.nickname
    user.isAdmin = user.role === 'admin'
    user.phoneVerified = !!user.phone_verified
    user.emailVerified = !!user.email_verified
    user.authMethod = user.auth_method || 'email'
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
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const cursor = decodeNotificationCursor(req.query.cursor)
    const cursorWhere = cursor
      ? ' AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))'
      : ''
    const cursorParams = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []
    const notifications = await queryAll(`
      SELECT n.id, n.user_id, n.type, n.title, n.message, n.link, n.is_read, n.priority,
             n.requires_ack, n.read_at, n.acknowledged_at, n.created_at
      FROM notifications n
      WHERE n.user_id = ?${cursorWhere}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?
    `, [req.user.id, ...cursorParams, limit + 1])

    const countRow = await queryOne('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id])
    const hasMore = notifications.length > limit
    const pageRows = hasMore ? notifications.slice(0, limit) : notifications
    const last = pageRows[pageRows.length - 1]

    res.json({
      ok: true,
      unreadCount:Number(countRow?.c || 0),
      nextCursor:hasMore && last ? encodeNotificationCursor(last.created_at, last.id) : null,
      notifications: pageRows.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        link:n.link || null,
        priority:n.priority || 'normal',
        requiresAck:Boolean(Number(n.requires_ack)),
        isRead: !!n.is_read,
        readAt:n.read_at || null,
        acknowledgedAt:n.acknowledged_at || null,
        createdAt: n.created_at,
      }))
    })
  } catch (err) {
    console.error('[notifications]', err.message)
    res.json({ ok: false, error: '获取通知失败' })
  }
})

router.patch('/notifications', authMiddleware, async (req, res) => {
  try {
    const { markAll, id } = req.body

    if (markAll) {
      await queryRun('UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE user_id = ? AND (is_read = 0 OR read_at IS NULL)', [req.user.id])
      await queryRun(`UPDATE notification_deliveries d JOIN notifications n ON n.id = d.notification_id
        SET d.read_at = COALESCE(d.read_at, NOW()), d.updated_at = NOW()
        WHERE n.user_id = ? AND n.is_read = 1 AND d.channel = 'in_app'`, [req.user.id])
    } else if (id) {
      await queryRun('UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?', [id, req.user.id])
      await queryRun(`UPDATE notification_deliveries d JOIN notifications n ON n.id = d.notification_id
        SET d.read_at = COALESCE(d.read_at, NOW()), d.updated_at = NOW()
        WHERE n.id = ? AND n.user_id = ? AND d.channel = 'in_app'`, [id, req.user.id])
    }

    const countRow = await queryOne('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id])
    res.json({ ok: true, unreadCount:Number(countRow?.c || 0) })
  } catch (err) {
    res.json({ ok: false, error: '操作失败' })
  }
})

function encodeNotificationCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ createdAt, id:Number(id) }), 'utf8').toString('base64url')
}

function decodeNotificationCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    const id = Number(parsed?.id)
    const createdAt = String(parsed?.createdAt || '')
    if (!Number.isSafeInteger(id) || id <= 0 || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(createdAt)) return null
    return { id, createdAt }
  } catch { return null }
}

async function loadNotificationSummary(userId) {
  const [counts, latestImportant] = await Promise.all([
    queryOne(`SELECT
      SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
      SUM(CASE WHEN priority = 'important' AND requires_ack = 1 AND acknowledged_at IS NULL THEN 1 ELSE 0 END) AS important_unacknowledged_count
      FROM notifications WHERE user_id = ?`, [userId]),
    queryOne(`SELECT id, title, message, link, priority, requires_ack, is_read, read_at, acknowledged_at, created_at
      FROM notifications WHERE user_id = ? AND priority = 'important' AND requires_ack = 1 AND acknowledged_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`, [userId]),
  ])
  return {
    unreadCount:Number(counts?.unread_count || 0),
    importantUnacknowledgedCount:Number(counts?.important_unacknowledged_count || 0),
    latestImportant:latestImportant ? {
      id:Number(latestImportant.id), title:latestImportant.title || '', message:latestImportant.message || '',
      link:latestImportant.link || null, priority:latestImportant.priority || 'important',
      requiresAck:Boolean(Number(latestImportant.requires_ack)), isRead:Boolean(Number(latestImportant.is_read)),
      readAt:latestImportant.read_at || null, acknowledgedAt:latestImportant.acknowledged_at || null,
      createdAt:latestImportant.created_at,
    } : null,
  }
}

router.get('/notifications/summary', authMiddleware, async (req, res) => {
  try {
    res.json({ ok:true, ...(await loadNotificationSummary(req.user.id)) })
  } catch (err) {
    console.error('[notifications/summary]', err.message)
    res.status(500).json({ ok:false, error:'获取通知摘要失败' })
  }
})

router.post('/notifications/:id/acknowledge', authMiddleware, async (req, res) => {
  try {
    const notificationId = Number(req.params.id)
    if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({ ok:false, error:'通知不存在' })
    }
    const existing = await queryOne(`SELECT id, requires_ack, acknowledged_at FROM notifications
      WHERE id = ? AND user_id = ?`, [notificationId, req.user.id])
    if (!existing) return res.status(404).json({ ok:false, error:'通知不存在' })
    if (!Number(existing.requires_ack)) return res.status(400).json({ ok:false, error:'该通知无需确认' })
    await queryRun(`UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()),
      acknowledged_at = COALESCE(acknowledged_at, NOW())
      WHERE id = ? AND user_id = ? AND requires_ack = 1 AND acknowledged_at IS NULL`, [notificationId, req.user.id])
    await queryRun(`UPDATE notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      SET d.read_at = COALESCE(d.read_at, NOW()), d.acknowledged_at = COALESCE(d.acknowledged_at, NOW()), d.updated_at = NOW()
      WHERE n.id = ? AND n.user_id = ? AND d.channel = 'in_app'`, [notificationId, req.user.id])
    const updated = await queryOne(`SELECT id, title, message, link, priority, requires_ack, is_read, read_at, acknowledged_at, created_at
      FROM notifications WHERE id = ? AND user_id = ?`, [notificationId, req.user.id])
    const summary = await loadNotificationSummary(req.user.id)
    res.json({ ok:true, ...summary, notification:updated ? {
      id:Number(updated.id), title:updated.title || '', message:updated.message || '', link:updated.link || null,
      priority:updated.priority || 'important', requiresAck:Boolean(Number(updated.requires_ack)), isRead:Boolean(Number(updated.is_read)),
      readAt:updated.read_at || null, acknowledgedAt:updated.acknowledged_at || null, createdAt:updated.created_at,
    } : null })
  } catch (err) {
    console.error('[notifications/acknowledge]', err.message)
    res.status(500).json({ ok:false, error:'确认通知失败' })
  }
})

router.get('/progress', authMiddleware, async (req, res) => {
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

    const proto = req.get('x-forwarded-proto') || req.protocol
    const hostname = req.hostname
    const port = req.get('host')?.split(':')?.[1] || ''
    const needsPort = port && !['80', '443'].includes(port)
    const baseUrl = needsPort ? `${proto}://${hostname}:${port}` : `${proto}://${hostname}`
    const referralLink = `${baseUrl}/?ref=${user.referral_code}`

    const invitedCount = referrals.length
    const paidCount = referrals.filter(r => r.status === 'approved').length
    const pendingCredit = referrals.filter(r => r.status === 'pending').reduce((sum, referral) => sum + Number(referral.commission || 0), 0)
    const availableCredit = user.referral_credit || 0

    res.json({
      ok: true,
      referral_code: user.referral_code,
      referral_link: referralLink,
      disabled: false,
      stats: {
        invited_count: invitedCount,
        paid_invited_count: paidCount,
        pending_credit_amount: pendingCredit,
        available_credit_amount: availableCredit,
        reserved_credit_amount: 0,
        used_credit_amount: 0,
      },
      recent_commissions: referrals.filter(r => r.status === 'approved').slice(0, 5).map(r => ({
        plan_label: r.plan_label || 'Plus',
        commission_amount: Number(r.commission || 0),
        status: r.status,
        status_label: '已确认',
        created_at: r.created_at,
        invited_user: { email_masked: (r.email || '').replace(/(.{2}).*(@.*)/, '$1***$2') },
      })),
      recent_invited_users: referrals.slice(0, 10).map(r => ({
        uid: r.referred_id,
        email_masked: (r.email || '').replace(/(.{2}).*(@.*)/, '$1***$2'),
        paid: r.status === 'approved',
        credit_amount: Number(r.commission || 0),
        attributed_at: r.attributed_at || r.created_at,
      })),
    })
  } catch (err) { res.json({ ok: false, error: '获取推荐信息失败' }) }
})

router.get('/referrals/track', authMiddleware, (req, res) => {
  try {
    res.json({ ok: true, referralCode: req.user?.referral_code || 'WSS' + String(req.user?.id || 0).padStart(4, '0') })
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

// Get user's changelog seen version
router.get('/changelog-status', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT changelog_seen_version FROM users WHERE id = ?', [req.user.id])
    res.json({ ok: true, seenVersion: user?.changelog_seen_version || 0 })
  } catch (err) {
    res.json({ ok: true, seenVersion: 0 })
  }
})

// Ack changelog (mark as seen)
router.post('/changelog-ack', authMiddleware, async (req, res) => {
  const { version } = req.body
  if (version === undefined || version === null) {
    return res.json({ ok: false, error: '版本号必填' })
  }
  try {
    await queryRun('UPDATE users SET changelog_seen_version = ? WHERE id = ?', [parseInt(version, 10), req.user.id])
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: '更新失败' })
  }
})

export default router
