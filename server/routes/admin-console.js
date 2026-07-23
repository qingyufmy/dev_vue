import { Router } from 'express'
import { queryAll, queryOne } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { translateAdminProfileError, updateAdminUserProfile } from '../admin/user-profile.js'

const router = Router()

function integer(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function serializeUser(row) {
  const expired = Boolean(Number(row.membership_expired || 0))
  return {
    id:Number(row.id),
    uid:row.uid || `WS${String(row.id).padStart(6, '0')}`,
    email:row.email || '',
    phone:row.phone || '',
    nickname:row.nickname || '',
    avatar:row.avatar || '',
    role:row.role || 'user',
    plan:row.plan || 'free',
    plan_source:row.plan_source || null,
    plan_expires_at:row.plan_expires_at || null,
    membership_expired:expired,
    membership_status:row.plan === 'free' ? 'free' : expired ? 'expired' : 'active',
    created_at:row.created_at || null,
    last_seen_at:row.last_seen_at || null,
    bridge_connected:Boolean(Number(row.bridge_connected || 0)),
    mt5_account_count:Number(row.mt5_account_count || 0),
    strategy_count:Number(row.strategy_count || 0),
  }
}

router.get('/admin/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [users, membership, activity, trading, review] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS total,
        SUM(DATE(created_at) = CURDATE()) AS today_new
        FROM users WHERE COALESCE(deletion_status, '') <> 'anonymized'`),
      queryOne(`SELECT
        SUM(plan = 'plus' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS plus_active,
        SUM(plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())) AS pro_active,
        SUM(plan IN ('plus','pro') AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()) AS expired
        FROM users WHERE COALESCE(deletion_status, '') <> 'anonymized'`),
      queryOne(`SELECT
        SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS online_now,
        SUM(last_seen_at >= CURDATE()) AS active_today
        FROM users WHERE COALESCE(deletion_status, '') <> 'anonymized'`),
      queryOne(`SELECT
        COUNT(DISTINCT CASE WHEN is_deleted = 0 THEN user_id END) AS connected_users,
        COUNT(CASE WHEN is_deleted = 0 THEN 1 END) AS accounts
        FROM trading_accounts`),
      queryOne(`SELECT COUNT(*) AS pending_reviews FROM period_review_cases
        WHERE status IN ('ready', 'generating', 'draft', 'edited', 'failed')`),
    ])
    res.json({ ok:true, overview:{
      total_users:Number(users?.total || 0),
      today_new_users:Number(users?.today_new || 0),
      plus_active:Number(membership?.plus_active || 0),
      pro_active:Number(membership?.pro_active || 0),
      expired_memberships:Number(membership?.expired || 0),
      online_now:Number(activity?.online_now || 0),
      active_today:Number(activity?.active_today || 0),
      connected_users:Number(trading?.connected_users || 0),
      trading_accounts:Number(trading?.accounts || 0),
      pending_reviews:Number(review?.pending_reviews || 0),
    } })
  } catch (error) {
    console.error('[AdminConsole] overview failed:', error)
    res.status(500).json({ ok:false, error:'管理概览加载失败' })
  }
})

router.get('/admin/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const page = integer(req.query.page, 1, 1, 100000)
    const pageSize = integer(req.query.page_size, 20, 5, 100)
    const search = String(req.query.search || '').trim()
    const membership = String(req.query.membership || 'all')
    const offset = (page - 1) * pageSize
    const where = ["COALESCE(u.deletion_status, '') <> 'anonymized'"]
    const params = []
    if (search) {
      where.push('(u.email LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ? OR u.uid LIKE ?)')
      const keyword = `%${search}%`
      params.push(keyword, keyword, keyword, keyword)
    }
    if (membership === 'active') where.push("u.plan IN ('plus','pro') AND (u.plan_expires_at IS NULL OR u.plan_expires_at >= NOW())")
    if (membership === 'expired') where.push("u.plan IN ('plus','pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()")
    if (membership === 'free') where.push("u.plan = 'free'")
    if (membership === 'plus' || membership === 'pro') where.push('u.plan = ?'), params.push(membership)
    const clause = where.join(' AND ')
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM users u WHERE ${clause}`, params)
    const rows = await queryAll(`SELECT u.id, u.uid, u.email, u.phone, u.nickname, u.avatar, u.role,
      u.plan, u.plan_source, u.plan_expires_at, u.created_at, u.last_seen_at,
      (u.plan IN ('plus','pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()) AS membership_expired,
      EXISTS(SELECT 1 FROM bridge_connection_status b WHERE b.user_id = u.id AND b.connected = 1
        AND b.updated_at >= DATE_SUB(NOW(), INTERVAL 90 SECOND)) AS bridge_connected,
      (SELECT COUNT(*) FROM trading_accounts ta WHERE ta.user_id = u.id AND ta.is_deleted = 0) AS mt5_account_count,
      (SELECT COUNT(*) FROM auto_prompt_types apt WHERE apt.owner_user_id = u.id AND apt.deleted_at IS NULL) AS strategy_count
      FROM users u WHERE ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset])
    const total = Number(totalRow?.total || 0)
    res.json({ ok:true, users:rows.map(serializeUser), pagination:{
      page, page_size:pageSize, total, total_pages:Math.max(1, Math.ceil(total / pageSize)),
    } })
  } catch (error) {
    console.error('[AdminConsole] users failed:', error)
    res.status(500).json({ ok:false, error:'用户目录加载失败' })
  }
})

router.get('/admin/users/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const userId = Number(req.params.userId)
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ ok:false, error:'用户编号无效' })
    const user = await queryOne(`SELECT u.id, u.uid, u.email, u.phone, u.nickname, u.avatar, u.role,
      u.plan, u.plan_source, u.plan_expires_at, u.created_at, u.last_seen_at,
      (u.plan IN ('plus','pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()) AS membership_expired
      FROM users u WHERE u.id = ? AND COALESCE(u.deletion_status, '') <> 'anonymized'`, [userId])
    if (!user) return res.status(404).json({ ok:false, error:'用户不存在' })
    const [settings, accounts, subscriptions] = await Promise.all([
      queryOne('SELECT trade_send_enabled, auto_reasoning_enabled, updated_at FROM user_bridge_settings WHERE user_id = ?', [userId]),
      queryAll(`SELECT id, broker_server, login_account AS mt5_login, nickname, observe_status, created_at, updated_at
        FROM trading_accounts WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC`, [userId]),
      queryAll(`SELECT ss.id, ss.strategy_id, ss.execution_enabled, ss.created_at, apt.title AS strategy_title,
        apt.scope AS strategy_scope FROM strategy_subscriptions ss
        LEFT JOIN auto_prompt_types apt ON apt.id = ss.strategy_id
        WHERE ss.user_id = ? AND ss.is_deleted = 0 ORDER BY ss.updated_at DESC`, [userId]),
    ])
    res.json({ ok:true, user:serializeUser(user), runtime:settings || {
      trade_send_enabled:0, auto_reasoning_enabled:0, updated_at:null,
    }, accounts, subscriptions })
  } catch (error) {
    console.error('[AdminConsole] user detail failed:', error)
    res.status(500).json({ ok:false, error:'用户档案加载失败' })
  }
})

router.patch('/admin/users/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const profile = await updateAdminUserProfile({
      actorUserId:req.user.id,
      targetUserId:req.params.userId,
      input:req.body || {},
    })
    res.json({ ok:true, profile })
  } catch (error) {
    const status = String(error?.message || '') === 'user_not_found' ? 404 : 400
    res.status(status).json({ ok:false, error:translateAdminProfileError(error) })
  }
})

export default router
