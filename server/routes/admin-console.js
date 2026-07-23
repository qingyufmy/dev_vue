import { Router } from 'express'
import { queryAll, queryOne } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { translateAdminProfileError, updateAdminUserProfile } from '../admin/user-profile.js'
import { getAdminAiOperationsOverview } from '../admin/ai-operations.js'
import { updateObserverChannel, updateObserverSource } from './ai/observer-channels.js'
import { reconcileAutoSchedulers } from './ai/scheduler.js'
import { applyBridgeRuntimeState } from '../bridge-ws.js'
import { getAdminPlatformRiskPolicy, getAdminRiskAuditOverview, listAdminAuditEvents, saveAdminPlatformRiskPolicy } from '../admin/risk-audit.js'
import { setGlobalKillSwitch } from './ai/risk-state.js'
import { deleteAdminCourse, getAdminContentSystemOverview, getAdminCourse, listAdminCourses, listAdminFeedback, saveAdminCourse } from '../admin/content-system.js'

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

const ORDER_STATUSES = new Set(['pending', 'processing', 'paid', 'expired', 'failed', 'cancelled'])

function serializeOrder(row) {
  return {
    id:Number(row.id),
    order_id:row.order_id || row.order_no,
    order_no:row.order_no || '',
    user_id:Number(row.user_id),
    user_uid:row.user_uid || '',
    user_name:row.user_name || '',
    user_email:row.user_email || '',
    plan:row.plan || '',
    plan_label:row.plan_label || '',
    period:row.period || '',
    period_label:row.period_label || '',
    amount_cents:Number(row.amount || 0),
    confirmed_cents:Number(row.amount_confirmed || 0),
    currency:row.currency || 'USD',
    status:row.status || 'pending',
    status_label:row.status_label || '',
    payment_method:row.payment_method || '',
    paid_at:row.paid_at || null,
    created_at:row.created_at || null,
  }
}

const AI_OPERATION_ERRORS = {
  observer_source_not_found:'观摩源不存在',
  observer_channel_not_found:'观摩频道不存在',
  observer_source_strategy_invalid:'观摩源绑定的策略不可用',
  observer_source_strategy_in_use:'该策略已被其他观摩源使用',
  bridge_user_not_found:'观摩源桥接账号不存在',
  bridge_user_requires_pro:'观摩源账号必须是有效 Pro 用户或管理员',
  trading_account_not_owned_by_source:'所选 MT5 账户不属于该观摩源账号',
  invalid_status:'状态值无效',
}

function adminAiError(res, error) {
  const code = String(error?.message || 'ai_operations_failed')
  const status = code.includes('not_found') ? 404 : 400
  res.status(status).json({ ok:false, error:AI_OPERATION_ERRORS[code] || 'AI 运营配置更新失败', code })
}

router.get('/admin/ai/overview', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, operations:await getAdminAiOperationsOverview() }) }
  catch (error) {
    console.error('[AdminConsole] AI operations overview failed:', error)
    res.status(500).json({ ok:false, error:'AI 运营数据加载失败' })
  }
})

router.patch('/admin/ai/observer-sources/:id/runtime', authMiddleware, adminOnly, async (req, res) => {
  try {
    const source = await updateObserverSource(req.params.id, {
      auto_inference_enabled:req.body?.auto_inference_enabled,
      trade_send_enabled:req.body?.trade_send_enabled,
    })
    await reconcileAutoSchedulers()
    const runtime_sync = await applyBridgeRuntimeState(Number(source.bridge_user_id), {
      tradeEnabled:Boolean(source.trade_send_enabled),
      autoReasoningEnabled:Boolean(source.auto_inference_enabled),
    })
    res.json({ ok:true, source, runtime_sync })
  } catch (error) { adminAiError(res, error) }
})

router.patch('/admin/ai/observer-channels/:id', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, channel:await updateObserverChannel(req.params.id, req.body || {}) }) }
  catch (error) { adminAiError(res, error) }
})

router.get('/admin/risk-audit/overview', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, ...(await getAdminRiskAuditOverview({ page:req.query.page, pageSize:req.query.page_size, decision:req.query.decision })) }) }
  catch (error) { console.error('[AdminConsole] risk audit overview failed:', error); res.status(500).json({ ok:false, error:'风控与审计数据加载失败' }) }
})

router.get('/admin/risk-audit/admin-events', authMiddleware, adminOnly, async (req, res) => {
  try { res.json({ ok:true, ...(await listAdminAuditEvents({ page:req.query.page, pageSize:req.query.page_size, search:req.query.search })) }) }
  catch (error) { console.error('[AdminConsole] admin audit events failed:', error); res.status(500).json({ ok:false, error:'管理操作记录加载失败' }) }
})

router.post('/admin/risk-audit/global-stop', authMiddleware, adminOnly, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled)
    const reason = String(req.body?.reason || '').trim()
    if (enabled && reason.length < 4) return res.status(400).json({ ok:false, error:'开启平台紧急停止时，请填写至少 4 个字的原因' })
    await setGlobalKillSwitch(req.user.id, req.user.role, enabled, reason)
    res.json({ ok:true })
  } catch (error) { adminAiError(res, error) }
})
router.get('/admin/risk-audit/platform-policy',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,policy:await getAdminPlatformRiskPolicy()})}
  catch(error){console.error('[AdminConsole] platform risk policy failed:',error);res.status(500).json({ok:false,error:'平台风控规则加载失败'})}
})
router.put('/admin/risk-audit/platform-policy',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,result:await saveAdminPlatformRiskPolicy({actorId:req.user.id,values:req.body?.values||{},controls:req.body?.controls||{},reason:req.body?.reason||''})})}
  catch(error){console.error('[AdminConsole] platform risk policy save failed:',error);res.status(400).json({ok:false,error:'平台风控规则保存失败，请检查输入范围'})}
})

router.get('/admin/content-system/overview', authMiddleware, adminOnly, async (req,res)=>{
  try{res.json({ok:true,overview:await getAdminContentSystemOverview()})}
  catch(error){console.error('[AdminConsole] content system overview failed:',error);res.status(500).json({ok:false,error:'内容与系统概览加载失败'})}
})
router.get('/admin/content-system/courses',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,...await listAdminCourses({page:req.query.page,pageSize:req.query.page_size,search:req.query.search,status:req.query.status})})}
  catch(error){console.error('[AdminConsole] course list failed:',error);res.status(500).json({ok:false,error:'课程列表加载失败'})}
})
router.get('/admin/content-system/courses/:courseId',authMiddleware,adminOnly,async(req,res)=>{
  try { const course=await getAdminCourse(req.params.courseId); if(!course)return res.status(404).json({ok:false,error:'课程不存在'}); res.json({ok:true,course}) }
  catch(error){console.error('[AdminConsole] course detail failed:',error);res.status(400).json({ok:false,error:'课程详情加载失败'})}
})
router.post('/admin/content-system/courses',authMiddleware,adminOnly,async(req,res)=>{
  try { res.json({ok:true,course:await saveAdminCourse(req.body||{})}) }
  catch(error){const labels={course_title_required:'请填写课程标题',invalid_course_category:'请选择正确的发布栏目',invalid_course_content_type:'请选择正确的课程类型',course_not_found:'课程不存在'};res.status(400).json({ok:false,error:labels[error.message]||'课程保存失败'})}
})
router.delete('/admin/content-system/courses/:courseId',authMiddleware,adminOnly,async(req,res)=>{
  try { res.json({ok:true,course:await deleteAdminCourse(req.params.courseId)}) }
  catch(error){res.status(error.message==='course_not_found'?404:400).json({ok:false,error:error.message==='course_not_found'?'课程不存在':'课程删除失败'})}
})
router.get('/admin/content-system/feedback',authMiddleware,adminOnly,async(req,res)=>{
  try{res.json({ok:true,...await listAdminFeedback({page:req.query.page,pageSize:req.query.page_size,search:req.query.search,type:req.query.type})})}
  catch(error){console.error('[AdminConsole] feedback list failed:',error);res.status(500).json({ok:false,error:'用户反馈加载失败'})}
})

router.get('/admin/commercial/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [orders, referrals, notifications] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'paid') AS paid,
        SUM(status IN ('pending','processing')) AS pending,
        SUM(status IN ('failed','expired','cancelled')) AS closed,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_confirmed ELSE 0 END), 0) AS revenue_cents,
        COALESCE(SUM(CASE WHEN status = 'paid' AND DATE(paid_at) = CURDATE() THEN amount_confirmed ELSE 0 END), 0) AS today_revenue_cents
        FROM orders`),
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'pending') AS pending,
        SUM(status = 'approved') AS approved,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN commission ELSE 0 END), 0) AS approved_cents
        FROM referrals`),
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'failed') AS failed,
        SUM(status IN ('pending','sending')) AS pending
        FROM membership_expiry_notifications`),
    ])
    res.json({ ok:true, overview:{
      orders_total:Number(orders?.total || 0),
      orders_paid:Number(orders?.paid || 0),
      orders_pending:Number(orders?.pending || 0),
      orders_closed:Number(orders?.closed || 0),
      revenue_cents:Number(orders?.revenue_cents || 0),
      today_revenue_cents:Number(orders?.today_revenue_cents || 0),
      referrals_total:Number(referrals?.total || 0),
      referrals_pending:Number(referrals?.pending || 0),
      referrals_approved:Number(referrals?.approved || 0),
      referral_approved_cents:Number(referrals?.approved_cents || 0),
      notifications_total:Number(notifications?.total || 0),
      notifications_failed:Number(notifications?.failed || 0),
      notifications_pending:Number(notifications?.pending || 0),
    } })
  } catch (error) {
    console.error('[AdminConsole] commercial overview failed:', error)
    res.status(500).json({ ok:false, error:'商业运营概览加载失败' })
  }
})

router.get('/admin/commercial/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const page = integer(req.query.page, 1, 1, 100000)
    const pageSize = integer(req.query.page_size, 20, 5, 100)
    const status = String(req.query.status || 'all').trim()
    const search = String(req.query.search || '').trim().slice(0, 100)
    const offset = (page - 1) * pageSize
    const where = []
    const params = []
    if (ORDER_STATUSES.has(status)) { where.push('o.status = ?'); params.push(status) }
    if (search) {
      const keyword = `%${search}%`
      where.push('(o.order_no LIKE ? OR o.order_id LIKE ? OR u.uid LIKE ? OR u.nickname LIKE ? OR u.email LIKE ?)')
      params.push(keyword, keyword, keyword, keyword, keyword)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${clause}`, params)
    const rows = await queryAll(`SELECT o.id, o.order_id, o.order_no, o.user_id, o.plan, o.plan_label,
      o.period, o.period_label, o.amount, o.amount_confirmed, o.currency, o.status,
      o.status_label, o.payment_method, o.paid_at, o.created_at,
      u.uid AS user_uid, u.nickname AS user_name, u.email AS user_email
      FROM orders o LEFT JOIN users u ON u.id = o.user_id ${clause}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset])
    const total = Number(totalRow?.total || 0)
    res.json({ ok:true, orders:rows.map(serializeOrder), pagination:{
      page, page_size:pageSize, total, total_pages:Math.max(1, Math.ceil(total / pageSize)),
    } })
  } catch (error) {
    console.error('[AdminConsole] commercial orders failed:', error)
    res.status(500).json({ ok:false, error:'订单记录加载失败' })
  }
})

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
