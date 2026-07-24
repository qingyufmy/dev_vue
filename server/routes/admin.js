import { Router } from 'express'
import multer from 'multer'
import { join, extname, basename } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { queryOne, queryAll, queryRun, withTransaction, logAudit } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { fetchBilibiliVideo } from '../utils.js'
import { translateAdminProfileError, updateAdminUserProfile } from '../admin/user-profile.js'
import { anonymizeAdminUser } from '../admin/user-deletion.js'
import {
  COURSE_ATTACHMENT_ACCEPT,
  deleteCourseAttachmentDirectory,
  deleteCourseAttachmentFile,
  serializeCourseAttachment,
  storeCourseAttachmentFile,
} from '../course-attachments.js'
import { PUBLIC_UPLOAD_DIR } from '../config.js'

const resourceDir = join(PUBLIC_UPLOAD_DIR, 'resources')
if (!existsSync(resourceDir)) mkdirSync(resourceDir, { recursive: true })

const resourceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (req, file, cb) => {
    // Fix Latin-1 encoding in filename (HTTP headers use Latin-1)
    try { file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8') } catch {}
    cb(null, true)
  },
})

const router = Router()
const COURSE_CATEGORIES = new Set(['morning', 'indicator', 'pattern', 'strategy', 'advanced'])
const COURSE_CONTENT_TYPES = new Set(['video', 'article'])

function serializeAdminCourse(c) {
  return {
    id: c.episode_id,
    episodeId: c.episode_id,
    number: c.number,
    title: c.title,
    description: c.description,
    category: c.category,
    contentType: c.content_type,
    duration: c.duration,
    youtubeId: c.youtube_id,
    bilibiliId: c.bilibili_id || '',
    cover: c.cover,
    gradient: c.gradient,
    articleUrl: c.article_url,
    articleObjectKey: c.article_object_key,
    accessLevel: c.access_level,
    hasStreamVideo: !!c.has_stream_video,
    quizCount: c.quiz_count,
    status: c.status,
    sortOrder: c.sort_order,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }
}

// Admin: get users with full stats and enriched data
router.get('/admin-users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, plan } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let where = '1=1'
    const params = []
    if (search) { where += ' AND (u.email LIKE ? OR u.nickname LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }
    if (plan === 'member') { where += " AND u.plan IN ('plus','pro')"; }
    else if (plan === 'plus' || plan === 'pro' || plan === 'free') { where += ' AND u.plan = ?'; params.push(plan); }

    // Dashboard stats
    const totalUsers = (await queryOne('SELECT COUNT(*) as c FROM users')).c
    const todayNewUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE DATE(created_at) = CURDATE()')).c

    let realtimeOnlineUsers = 0, todayOnlineUsers = 0, weekOnlineUsers = 0
    try {
      realtimeOnlineUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)')).c
      todayOnlineUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE last_seen_at >= CURDATE()')).c
      weekOnlineUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE YEARWEEK(last_seen_at, 1) = YEARWEEK(NOW(), 1)')).c
    } catch (e) { console.error('[Admin] Online users query failed:', e.message) }

    const plusUsers = (await queryOne("SELECT COUNT(*) as c FROM users WHERE plan = 'plus' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())")).c
    const proUsers = (await queryOne("SELECT COUNT(*) as c FROM users WHERE plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW())")).c

    let totalRevenue = 0, paidOrderCount = 0
    try {
      const revenueRes = await queryOne("SELECT COALESCE(SUM(amount_confirmed), 0) as total, COUNT(*) as cnt FROM orders WHERE status = 'paid'")
      totalRevenue = Math.round(revenueRes.total / 100)
      paidOrderCount = revenueRes.cnt
    } catch (e) { console.error('[Admin] Revenue query failed:', e.message) }

    let totalPosts = 0, totalComments = 0, totalReplies = 0
    try {
      totalPosts = (await queryOne('SELECT COUNT(*) as c FROM posts')).c
      totalComments = (await queryOne('SELECT COUNT(*) as c FROM comments')).c
      totalReplies = (await queryOne('SELECT COUNT(*) as c FROM post_replies')).c
    } catch (e) { console.error('[Admin] Content stats query failed:', e.message) }

    // Get users with pagination
    const userCount = (await queryOne(`SELECT COUNT(*) as c FROM users u WHERE ${where}`, params)).c
    const users = await queryAll(`
      SELECT u.id, u.uid, u.email, u.phone, u.nickname, u.avatar, u.role, u.plan, u.plan_period, u.plan_expires_at,
             u.referral_code, u.referral_credit, u.telegram_id, u.created_at, u.last_seen_at
      FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset])

    // Enrich each user with progress, orders, and content counts
    const enrichedUsers = []
    // Batch load all user stats in parallel (avoid N+1 queries)
    const userIds = users.map(u => u.id)

    // 空列表时提前返回，避免 WHERE id IN () 语法错误
    if (userIds.length === 0) {
      return res.json({ ok: true, users: [], total: 0, page, limit, totalPages: 0 })
    }

    const placeholders = userIds.map(() => '?').join(',')
    const batchParams = userIds

    const [progressRows, orderRows, contentRows, activityRows] = await Promise.all([
      // Progress stats grouped by user
      queryAll(
        `SELECT user_id, COUNT(*) as total, SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN quiz_passed = 1 THEN 1 ELSE 0 END) as quizPassed FROM progress WHERE user_id IN (${placeholders}) GROUP BY user_id`,
        batchParams
      ),
      // Orders
      queryAll(
        `SELECT * FROM orders WHERE user_id IN (${placeholders}) ORDER BY user_id, created_at DESC`,
        batchParams
      ),
      // Content counts
      queryAll(
        `SELECT u.id as uid,
          (SELECT COUNT(*) FROM comments WHERE user_id = u.id) as commentCount,
          (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as postCount,
          (SELECT COUNT(*) FROM post_replies WHERE user_id = u.id) as replyCount
         FROM (SELECT DISTINCT id FROM users WHERE id IN (${placeholders})) u`,
        batchParams
      ),
      // Last activity
      queryAll(
        `SELECT u.id as uid,
          GREATEST(
            COALESCE(u.last_seen_at, '1970-01-01'),
            COALESCE(MAX(c.created_at), '1970-01-01'),
            COALESCE(MAX(p.created_at), '1970-01-01'),
            COALESCE(MAX(r.created_at), '1970-01-01')
          ) as lastActivity
         FROM (SELECT id, last_seen_at FROM users WHERE id IN (${placeholders})) u
         LEFT JOIN comments c ON c.user_id = u.id
         LEFT JOIN posts p ON p.user_id = u.id
         LEFT JOIN post_replies r ON r.user_id = u.id
         GROUP BY u.id, u.last_seen_at`,
        batchParams
      ),
    ])

    // Index results by user_id for O(1) lookup
    const progressMap = new Map()
    for (const r of progressRows) progressMap.set(r.user_id, { completed: r.completed || 0, quizPassed: r.quizPassed || 0, total: r.total || 0 })

    const contentMap = new Map()
    for (const r of contentRows) contentMap.set(r.uid, { commentCount: r.commentCount || 0, postCount: r.postCount || 0, replyCount: r.replyCount || 0 })

    const activityMap = new Map()
    for (const r of activityRows) activityMap.set(r.uid, r.lastActivity !== '1970-01-01' ? r.lastActivity : null)

    for (const u of users) {
      const progressData = progressMap.get(u.id) || { completed: 0, quizPassed: 0, total: 0 }
      const contentData = contentMap.get(u.id) || { commentCount: 0, postCount: 0, replyCount: 0 }

      // Filter orders for this user
      const userOrders = orderRows.filter(o => o.user_id === u.id).map(o => ({
        orderId: o.order_id || o.order_no,
        plan: o.plan,
        planLabel: o.plan_label || o.plan,
        period: o.period,
        periodLabel: o.period_label || o.period,
        amount: o.amount,
        amountConfirmed: o.amount_confirmed || o.amount,
        status: o.status,
        statusLabel: o.status_label || o.status,
        paidAt: o.paid_at,
        createdAt: o.created_at,
      }))

      const totalPaid = userOrders
        .filter(o => o.status === 'paid')
        .reduce((sum, o) => sum + (Number(o.amountConfirmed) || 0), 0)

      enrichedUsers.push({
        id: u.id,
        uid: u.uid || ('WS' + String(u.id).padStart(6, '0')),
        email: u.email,
        phone: u.phone || '',
        name: u.nickname || (u.email || '').split('@')[0] || 'Unknown',
        nickname: u.nickname,
        avatar: u.avatar,
        role: u.role,
        isAdmin: u.role === 'admin',
        plan: u.plan,
        planPeriod: u.plan_period,
        planExpiresAt: u.plan_expires_at,
        referralCode: u.referral_code,
        referralCredit: u.referral_credit,
        telegramId: u.telegram_id,
        createdAt: u.created_at,
        progress: progressData,
        orders: userOrders,
        totalPaid,
        commentCount: contentData.commentCount,
        postCount: contentData.postCount,
        replyCount: contentData.replyCount,
        lastActivity: activityMap.get(u.id) || u.last_seen_at || null,
      })
    }

    res.json({
      ok: true,
      stats: {
        totalUsers,
        todayNewUsers,
        plusUsers,
        proUsers,
        totalRevenue,
        paidOrderCount,
        totalPosts,
        totalComments,
        totalReplies,
        realtimeOnlineUsers,
        todayOnlineUsers,
        weekOnlineUsers,
        realtimeWindowMinutes: 5,
      },
      users: enrichedUsers,
      total: userCount,
      page: Number(page),
      totalPages: Math.ceil(userCount / Number(limit))
    })
  } catch (err) {
    console.error('Admin users error:', err)
    res.json({ ok: false, error: '获取用户失败' })
  }
})

// Admin: update user (plan, role, etc.)
router.post('/admin-users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { userId, plan, expiresAt, role, nickname } = req.body
    const input = {}
    if (plan !== undefined) input.plan = plan
    if (expiresAt !== undefined) input.expires_at = expiresAt
    if (role !== undefined) input.role = role
    if (nickname !== undefined) input.nickname = nickname
    const profile = await updateAdminUserProfile({ actorUserId:req.user.id, targetUserId:userId, input })
    res.json({ ok: true, profile })
  } catch (err) { res.json({ ok: false, error: translateAdminProfileError(err) }) }
})

router.put('/admin-users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id, userId, role, plan, nickname, email, phone, password, avatar, expiresAt } = req.body
    const uid = id || userId
    if (!uid) return res.json({ ok: false, error: '缺少用户ID' })
    const input = {}
    for (const [key, value] of Object.entries({ role, plan, nickname, email, phone, password, avatar })) {
      if (value !== undefined) input[key] = value
    }
    if (expiresAt !== undefined) input.expires_at = expiresAt
    const profile = await updateAdminUserProfile({ actorUserId:req.user.id, targetUserId:uid, input })
    res.json({ ok: true, profile })
  } catch (err) {
    console.error('Admin update user error:', err)
    res.json({ ok: false, error: translateAdminProfileError(err) })
  }
})

router.delete('/admin-users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await anonymizeAdminUser({ actor:req.user, targetUserId:req.params.id })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete user error:', err)
    res.json({ ok: false, error: '删除失败' })
  }
})

router.get('/admin-audit', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 30, action, search, days } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let where = '1=1'
    const params = []
    if (action && action !== 'all') { where += ' AND a.action = ?'; params.push(action) }
    if (search) { where += ' AND (a.user_email LIKE ? OR a.user_nickname LIKE ? OR a.detail LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`) }
    if (days && days !== 'all') {
      where += ' AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)'
      params.push(Number(days))
    }

    const total = (await queryOne(`SELECT COUNT(*) as c FROM audit_logs a WHERE ${where}`, params)).c
    const logs = await queryAll(`
      SELECT a.id, a.user_id, a.user_email, a.user_nickname, a.action, a.target_type, a.target_id,
             a.detail, a.ip, a.created_at
      FROM audit_logs a WHERE ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset])

    res.json({ ok: true, logs, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) })
  } catch (err) {
    console.error('Admin audit error:', err)
    res.json({ ok: false, error: '获取日志失败' })
  }
})

// Admin: referrals
router.get('/admin/referrals/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const total = (await queryOne('SELECT COUNT(*) as c FROM referrals')).c
    const pending = (await queryOne("SELECT COUNT(*) as c FROM referrals WHERE status = 'pending'")).c
    const approved = (await queryOne("SELECT COUNT(*) as c FROM referrals WHERE status = 'approved'")).c
    const pendingCommission = (await queryOne("SELECT COALESCE(SUM(commission), 0) as c FROM referrals WHERE status = 'pending'")).c
    const totalCommission = (await queryOne("SELECT COALESCE(SUM(commission), 0) as c FROM referrals WHERE status = 'approved'")).c
    res.json({
      ok: true,
      total, pending, approved, totalCommission,
      stats: {
        total_invites: total,
        paid_invites: approved,
        pending_credit_amount: Number(pendingCommission || 0),
        available_credit_amount: Number(totalCommission || 0),
      },
    })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.get('/admin/referrals/commissions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status } = req.query
    let where = '1=1'
    const params = []
    if (status) { where += ' AND r.status = ?'; params.push(status) }

    const rows = await queryAll(`
      SELECT r.*, 
        u.nickname as referrer_name, u.email as referrer_email, u.uid as referrer_uid,
        u2.nickname as referred_name, u2.email as referred_email, u2.uid as referred_uid,
        o.order_id as order_id, o.plan as order_plan, o.plan_label as order_plan_label,
        o.period as order_period, o.period_label as order_period_label,
        o.amount_confirmed as order_amount_confirmed
      FROM referrals r 
      LEFT JOIN users u ON r.referrer_id = u.id 
      LEFT JOIN users u2 ON r.referred_id = u2.id
       LEFT JOIN orders o ON o.order_id = r.order_id
      WHERE ${where} ORDER BY r.created_at DESC LIMIT 100
    `, params)

    const commissions = rows.map(r => ({
      id: r.id,
      referrer: { name: r.referrer_name, email: r.referrer_email, uid: r.referrer_uid },
      invited_user: { name: r.referred_name, email: r.referred_email, uid: r.referred_uid },
      order_id: r.order_id || null,
      plan: r.order_plan_label || r.plan_label || '',
      period: r.order_period_label || '',
      source_cash_amount: r.order_amount_confirmed ?? r.cash_amount ?? 0,
      commission_amount: r.commission || 0,
      rate_bps: r.cash_amount > 0 ? Math.round((r.commission / r.cash_amount) * 10000) : 500,
      status: r.status,
      available_at: r.attributed_at || r.created_at,
      created_at: r.created_at,
    }))

    res.json({ ok: true, commissions })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.patch('/admin/referrals/commissions/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { action } = req.body
    const finalStatus = action === 'approve' ? 'approved' : action === 'void' ? 'voided' : ''
    if (!finalStatus) return res.status(400).json({ ok:false, error:'无效的返佣操作' })
    const result = await withTransaction(async run => {
      const [rows] = await run('SELECT referrer_id, commission, status FROM referrals WHERE id = ? FOR UPDATE', [req.params.id])
      const referral = rows[0]
      if (!referral) return { ok:false, status:404, error:'返佣记录不存在' }
      if (referral.status === finalStatus) return { ok:true, unchanged:true }
      if (referral.status !== 'pending') return { ok:false, status:409, error:'该返佣已经处理，不能重复操作' }
      await run('UPDATE referrals SET status = ?, commission = CASE WHEN ? = \"voided\" THEN 0 ELSE commission END WHERE id = ?', [finalStatus, finalStatus, req.params.id])
      if (finalStatus === 'approved' && Number(referral.commission) > 0) {
        await run('UPDATE users SET referral_credit = referral_credit + ?, updated_at = NOW() WHERE id = ?', [referral.commission, referral.referrer_id])
      }
      return { ok:true }
    })
    if (!result.ok) return res.status(result.status).json({ ok:false, error:result.error })
    res.json({ ok:true, unchanged:Boolean(result.unchanged) })
  } catch (err) {
    console.error('[Admin] referral commission update failed:', err)
    res.status(500).json({ ok:false, error:'返佣操作失败，请稍后重试' })
  }
})

router.get('/admin/referrals/rules', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rules = await queryAll('SELECT plan, period, rate_bps, enabled FROM referral_rules ORDER BY plan, period')
    res.json({ ok: true, rules })
  } catch (err) { res.json({ ok: false, error: '获取规则失败' }) }
})

router.put('/admin/referrals/rules', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rules } = req.body
    if (!Array.isArray(rules)) return res.status(400).json({ ok:false, error:'规则列表格式无效' })
    const allowedPlans = new Set(['plus', 'pro'])
    const allowedPeriods = new Set(['monthly', 'yearly'])
    const normalized = rules.map(rule => {
      const plan = String(rule?.plan || '').trim().toLowerCase()
      const period = String(rule?.period || '').trim().toLowerCase()
      const rateBps = Number(rule?.rate_bps)
      if (!allowedPlans.has(plan) || !allowedPeriods.has(period)) throw new Error('referral_rule_scope_invalid')
      if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) throw new Error('referral_rule_rate_invalid')
      return { plan, period, rate_bps:rateBps, enabled:Boolean(rule?.enabled) }
    })
    const unique = new Set(normalized.map(rule => `${rule.plan}:${rule.period}`))
    if (unique.size !== normalized.length || normalized.length > 4) throw new Error('referral_rule_duplicate')
    for (const rule of normalized) {
      await queryRun(
        'INSERT INTO referral_rules (plan, period, rate_bps, enabled) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE rate_bps = VALUES(rate_bps), enabled = VALUES(enabled)',
        [rule.plan, rule.period, rule.rate_bps, rule.enabled ? 1 : 0]
      )
    }
    await logAudit({ userId:req.user.id, action:'referral_rules_updated', targetType:'referral_rules',
      detail:JSON.stringify({ rules:normalized }), ip:req.ip, userAgent:req.get('user-agent') })
    res.json({ ok:true, message:'返佣规则已更新' })
  } catch (err) {
    const messages={ referral_rule_scope_invalid:'仅支持 Plus/Pro 的月付与年付规则', referral_rule_rate_invalid:'返佣比例必须为 0% 到 100%', referral_rule_duplicate:'返佣规则存在重复项' }
    res.status(err?.message?.startsWith('referral_rule_')?400:500).json({ ok:false, error:messages[err?.message] || '更新返佣规则失败' })
  }
})

// Admin: course items
router.get('/admin-course-items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const courses = await queryAll('SELECT * FROM courses ORDER BY created_at DESC')
    res.json({ ok: true, courses: courses.map(serializeAdminCourse) })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-course-items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { episodeId, number, title, description, duration, youtubeId, bilibiliId, cover, accessLevel, sortOrder, articleUrl, articleObjectKey, status } = req.body
    const category = String(req.body.category || '').trim()
    const contentType = String(req.body.contentType || '').trim()
    if (!category) return res.status(400).json({ ok: false, error: '请选择发布栏目' })
    if (!COURSE_CATEGORIES.has(category)) return res.status(400).json({ ok: false, error: '无效的发布栏目' })
    if (!COURSE_CONTENT_TYPES.has(contentType)) return res.status(400).json({ ok: false, error: '无效的课程类型' })

    // Shared: auto-fetch Bilibili cover + duration
    let finalCover = cover, finalDuration = duration
    if (bilibiliId) {
      try {
        const bi = await fetchBilibiliVideo(bilibiliId)
        if (bi) {
          if (bi.cover) finalCover = bi.cover
          if ((!duration || duration === '') && bi.duration) finalDuration = bi.duration
        }
      } catch (e) { console.error('[Admin] Bilibili API fetch failed:', e.message) }
    }

    if (episodeId) {
      await queryRun(`
        UPDATE courses SET number=?, title=?, description=?, category=?, content_type=?, duration=?,
        youtube_id=?, bilibili_id=?, cover=?, access_level=?, sort_order=?, article_url=?, article_object_key=?,
        status=?, updated_at=NOW() WHERE episode_id=?
      `, [number, title, description, category, contentType, finalDuration, youtubeId || '', bilibiliId || '', finalCover, accessLevel, sortOrder, articleUrl, articleObjectKey, status, episodeId])
      const course = await queryOne('SELECT * FROM courses WHERE episode_id = ?', [episodeId])
      res.json({ ok: true, course: serializeAdminCourse(course) })
    } else {
      const maxRow = await queryOne('SELECT MAX(episode_id) as m FROM courses')
      const maxId = maxRow?.m || 0
      await queryRun(`
        INSERT INTO courses (episode_id, number, title, description, category, content_type, duration, youtube_id, bilibili_id, cover, access_level, sort_order, article_url, article_object_key, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [maxId + 1, number || maxId + 1, title, description, category, contentType, finalDuration, youtubeId || '', bilibiliId || '', finalCover, accessLevel, sortOrder, articleUrl, articleObjectKey, status || 'published'])
      const course = await queryOne('SELECT * FROM courses WHERE episode_id = ?', [maxId + 1])
      res.json({ ok: true, course: serializeAdminCourse(course) })
    }
  } catch (err) { console.error('[AdminCourse] Error:', err); res.json({ ok: false, error: '保存失败' }) }
})

router.delete('/admin-course-items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { episode } = req.query
    if (!episode) return res.json({ ok: false, error: '缺少课程ID' })

    // Check if course exists
    const course = await queryOne('SELECT * FROM courses WHERE episode_id = ?', [episode])
    if (!course) return res.json({ ok: false, error: '课程不存在' })

    // Delete related data in transaction
    await withTransaction(async (run) => {
      await run('DELETE FROM quiz_questions WHERE episode_id = ?', [episode])
      await run('DELETE FROM course_resources WHERE episode_id = ?', [episode])
      await run('DELETE FROM video_streams WHERE episode_id = ?', [episode])
      await run('DELETE FROM progress WHERE episode_id = ?', [episode])
      await run('DELETE FROM comments WHERE episode_id = ?', [episode])
      await run('DELETE FROM courses WHERE episode_id = ?', [episode])
    })
    try { deleteCourseAttachmentDirectory(episode) } catch (error) { console.error('Course attachment directory cleanup error:', error) }

    res.json({ ok: true, message: '课程已删除' })
  } catch (err) {
    console.error('Delete course error:', err)
    res.json({ ok: false, error: '删除失败' })
  }
})

// Admin: course resources
router.get('/admin-course-resources', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { episode } = req.query
    const resources = await queryAll('SELECT * FROM course_resources WHERE episode_id = ? ORDER BY sort_order', [episode])
    const quizCount = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [episode])).c
    const attachments = resources.filter(resource => resource.type === 'attachment').map(serializeCourseAttachment)
    const learningResources = resources.filter(resource => resource.type !== 'attachment')

    const assets = learningResources.map(r => ({
      id: r.id, type: r.type, title: r.title,
      assetType: r.type === 'mindmap' ? (r.structure ? 'mindmap_structure' : 'mindmap_image') : r.type,
    }))

    res.json({ ok: true, quizCount, assets, resources:learningResources, attachments, attachmentAccept:COURSE_ATTACHMENT_ACCEPT })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-course-attachments', authMiddleware, adminOnly, resourceUpload.array('files', 10), async (req, res) => {
  const savedRows = []
  try {
    const episodeId = Number(req.body.episodeId)
    const course = Number.isInteger(episodeId) && episodeId > 0
      ? await queryOne('SELECT episode_id FROM courses WHERE episode_id = ?', [episodeId])
      : null
    if (!course) return res.status(404).json({ ok:false, error:'课程不存在' })
    const files = Array.isArray(req.files) ? req.files : []
    if (!files.length) return res.status(400).json({ ok:false, error:'请选择要上传的附件' })
    const maxSort = await queryOne("SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM course_resources WHERE episode_id = ? AND type = 'attachment'", [episodeId])
    let sortOrder = Number(maxSort?.max_sort ?? -1) + 1
    const attachments = []
    const skipped = []
    for (const file of files) {
      let stored = null
      try {
        stored = storeCourseAttachmentFile(episodeId, file)
        savedRows.push({ episode_id:episodeId, url:stored.uri })
        const result = await queryRun(`INSERT INTO course_resources (episode_id, type, title, content, url, structure, sort_order)
          VALUES (?, 'attachment', ?, '', ?, ?, ?)`, [episodeId, stored.title, stored.uri, JSON.stringify(stored.metadata), sortOrder++])
        attachments.push(serializeCourseAttachment({
          id:result.insertId,
          episode_id:episodeId,
          type:'attachment',
          title:stored.title,
          url:stored.uri,
          structure:JSON.stringify(stored.metadata),
          sort_order:sortOrder - 1,
        }))
      } catch (error) {
        if (stored) deleteCourseAttachmentFile({ episode_id:episodeId, url:stored.uri })
        skipped.push({ name:file.originalname || '未命名附件', reason:error.message || '上传失败' })
      }
    }
    if (!attachments.length) return res.status(400).json({ ok:false, error:skipped[0]?.reason || '附件上传失败', skipped })
    res.status(201).json({ ok:true, attachments, skipped })
  } catch (error) {
    for (const row of savedRows) {
      try { deleteCourseAttachmentFile(row) } catch {}
    }
    console.error('Course attachment upload error:', error)
    res.status(400).json({ ok:false, error:error.message || '附件上传失败' })
  }
})

router.delete('/admin-course-attachments/:attachmentId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const attachment = await queryOne("SELECT * FROM course_resources WHERE id = ? AND type = 'attachment'", [req.params.attachmentId])
    if (!attachment) return res.status(404).json({ ok:false, error:'附件不存在' })
    await queryRun("DELETE FROM course_resources WHERE id = ? AND type = 'attachment'", [attachment.id])
    try { deleteCourseAttachmentFile(attachment) } catch (error) { console.error('Course attachment file cleanup error:', error) }
    res.json({ ok:true, attachment:serializeCourseAttachment(attachment) })
  } catch (error) {
    console.error('Course attachment delete error:', error)
    res.status(400).json({ ok:false, error:'附件删除失败' })
  }
})

router.post('/admin-course-resources', authMiddleware, adminOnly, resourceUpload.array('files', 50), async (req, res) => {
  try {
    const episodeId = Number(req.body.episodeId)
    const includeQuiz = req.body.includeQuiz === '1'
    const includeMindmap = req.body.includeMindmap === '1'
    const includeInfographic = req.body.includeInfographic === '1'
    const files = req.files || []

    if (!episodeId) return res.json({ ok: false, error: '缺少课程ID' })

    // Ensure episode dir exists
    const epDir = join(resourceDir, `ep${episodeId}`)
    if (!existsSync(epDir)) mkdirSync(epDir, { recursive: true })

    let quizFiles = 0, assetFiles = 0
    const skipped = []

    // Classify files by name patterns
    const isQuizFile = (name) => /quiz|题目|答题|测验/i.test(name) && /\.json$/i.test(name)
    const isMindmapFile = (name) => /mindmap|导图|思维|structure/i.test(name)
    const isInfographicFile = (name) => /infographic|信息图|图解/i.test(name)
    const isImageFile = (name) => /\.(png|jpg|jpeg|svg|webp)$/i.test(name)
    const isJsonFile = (name) => /\.json$/i.test(name)

    for (const file of files) {
      const origName = file.originalname
      const relPath = file.originalname // ep{episodeId}/filename or just filename
      const baseName = basename(relPath) // Sanitize: strip all path components

      try {
        // === QUIZ JSON ===
        if (includeQuiz && (isQuizFile(baseName) || (isJsonFile(baseName) && !isMindmapFile(baseName)))) {
          const content = file.buffer.toString('utf-8')
          let questions
          try {
            questions = JSON.parse(content)
          } catch {
            skipped.push({ name: baseName, reason: 'JSON 解析失败' })
            continue
          }
          if (!Array.isArray(questions)) questions = [questions]

          let inserted = 0
          for (const q of questions) {
            if (!q.question || !q.options) continue
            const options = Array.isArray(q.options) ? q.options : [q.options]
            const answer = q.answer ?? q.correctIndex ?? q.correct_index ?? 0
            const explanations = Array.isArray(q.explanations) ? q.explanations : []

            await queryRun(`
              INSERT INTO quiz_questions (episode_id, question, options, correct_index, explanation, explanations, hint, status, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)
            `, [
              episodeId,
              q.question,
              JSON.stringify(options),
              answer,
              q.explanation || '',
              JSON.stringify(explanations),
              q.hint || '',
              inserted
            ])
            inserted++
          }
          if (inserted > 0) {
            quizFiles++
            // Update quiz_count
            const count = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [episodeId])).c
            await queryRun('UPDATE courses SET quiz_count = ? WHERE episode_id = ?', [count, episodeId])
          }
        }
        // === MINDMAP ===
        else if (includeMindmap && isMindmapFile(baseName)) {
          if (isJsonFile(baseName)) {
            // Structure JSON
            const content = file.buffer.toString('utf-8')
            let structure
            try { structure = JSON.parse(content) } catch { skipped.push({ name: baseName, reason: 'JSON 解析失败' }); continue }

            // Save file to disk
            const savePath = join(epDir, baseName)
            writeFileSync(savePath, content, 'utf-8')

            await queryRun(`
              INSERT INTO course_resources (episode_id, type, title, url, structure, sort_order)
              VALUES (?, 'mindmap', ?, ?, ?, ?)
            `, [episodeId, structure.title || baseName, `/uploads/resources/ep${episodeId}/${baseName}`, content, assetFiles])
            assetFiles++
          } else if (isImageFile(baseName)) {
            // Mindmap image
            const ext = extname(baseName) || '.png'
            const saveName = `mindmap_${Date.now()}${ext}`
            writeFileSync(join(epDir, saveName), file.buffer)

            await queryRun(`
              INSERT INTO course_resources (episode_id, type, title, url, sort_order)
              VALUES (?, 'mindmap', ?, ?, ?)
            `, [episodeId, baseName.replace(/\.[^.]+$/, ''), `/uploads/resources/ep${episodeId}/${saveName}`, assetFiles])
            assetFiles++
          } else {
            skipped.push({ name: baseName, reason: '不支持的思维导图格式' })
          }
        }
        // === INFOGRAPHIC ===
        else if (includeInfographic && isInfographicFile(baseName)) {
          if (isImageFile(baseName)) {
            const ext = extname(baseName) || '.png'
            const saveName = `info_${Date.now()}${ext}`
            writeFileSync(join(epDir, saveName), file.buffer)

            await queryRun(`
              INSERT INTO course_resources (episode_id, type, title, url, sort_order)
              VALUES (?, 'knowledge', ?, ?, ?)
            `, [episodeId, baseName.replace(/\.[^.]+$/, ''), `/uploads/resources/ep${episodeId}/${saveName}`, assetFiles])
            assetFiles++
          } else {
            skipped.push({ name: baseName, reason: '信息图仅支持图片格式' })
          }
        }
        // === AUTO-DETECT (no checkbox filter, or unrecognized) ===
        else {
          // Try to auto-detect
          if (isJsonFile(baseName) && includeQuiz) {
            // Treat unknown JSON as quiz
            const content = file.buffer.toString('utf-8')
            let questions
            try { questions = JSON.parse(content) } catch { skipped.push({ name: baseName, reason: 'JSON 解析失败' }); continue }
            if (!Array.isArray(questions)) questions = [questions]
            let inserted = 0
            for (const q of questions) {
              if (!q.question || !q.options) continue
              const options = Array.isArray(q.options) ? q.options : [q.options]
              const answer = q.answer ?? 0
              await queryRun(`
                INSERT INTO quiz_questions (episode_id, question, options, correct_index, explanation, explanations, hint, status, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)
              `, [episodeId, q.question, JSON.stringify(options), answer, q.explanation || '', JSON.stringify(q.explanations || []), q.hint || '', inserted])
              inserted++
            }
            if (inserted > 0) { quizFiles++; const c = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [episodeId])).c; await queryRun('UPDATE courses SET quiz_count = ? WHERE episode_id = ?', [c, episodeId]) }
          } else if (isImageFile(baseName) && (includeMindmap || includeInfographic)) {
            const ext = extname(baseName) || '.png'
            const saveName = `res_${Date.now()}${ext}`
            writeFileSync(join(epDir, saveName), file.buffer)
            const type = includeMindmap ? 'mindmap' : 'knowledge'
            await queryRun(`
              INSERT INTO course_resources (episode_id, type, title, url, sort_order)
              VALUES (?, ?, ?, ?, ?)
            `, [episodeId, type, baseName.replace(/\.[^.]+$/, ''), `/uploads/resources/ep${episodeId}/${saveName}`, assetFiles])
            assetFiles++
          } else {
            skipped.push({ name: baseName, reason: '无法识别文件类型' })
          }
        }
      } catch (fileErr) {
        console.error('File processing error:', fileErr)
        skipped.push({ name: baseName, reason: '处理失败' })
      }
    }

    // Update course resource counts
    const mindmapCount = (await queryOne("SELECT COUNT(*) as c FROM course_resources WHERE episode_id = ? AND type = 'mindmap'", [episodeId])).c
    const knowledgeCount = (await queryOne("SELECT COUNT(*) as c FROM course_resources WHERE episode_id = ? AND type = 'knowledge'", [episodeId])).c
    await queryRun('UPDATE courses SET mindmap_count = ?, knowledge_count = ? WHERE episode_id = ?', [mindmapCount, knowledgeCount, episodeId])

    res.json({ ok: true, quizFiles, assetFiles, skipped })
  } catch (err) {
    console.error('Resource upload error:', err)
    res.json({ ok: false, error: '上传失败' })
  }
})

// Admin: quiz
router.get('/admin-quiz', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { episode } = req.query
    const questions = await queryAll('SELECT * FROM quiz_questions WHERE episode_id = ? ORDER BY sort_order', [episode])
    res.json({ ok: true, questions: questions.map(q => ({
      id: q.id, question: q.question, options: JSON.parse(q.options || '[]'),
      answer: q.answer ?? q.correct_index, explanation: q.explanation,
      explanations: JSON.parse(q.explanations || '[]'), hint: q.hint,
      status: q.status, sortOrder: q.sort_order,
    })) })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-quiz', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id, episodeId, question, options, answer, correctIndex, explanation, explanations, hint, status, sortOrder } = req.body

    // If id is provided, update existing question
    if (id) {
      await queryRun(`
        UPDATE quiz_questions SET question=?, options=?, correct_index=?, explanation=?, explanations=?, hint=?, status=?, sort_order=? WHERE id=?
      `, [question, JSON.stringify(options), correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0, id])

      // Update course quiz_count
      const q = await queryOne('SELECT episode_id FROM quiz_questions WHERE id = ?', [id])
      if (q) {
        const count = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [q.episode_id])).c
        await queryRun('UPDATE courses SET quiz_count = ? WHERE episode_id = ?', [count, q.episode_id])
      }

      return res.json({ ok: true, id })
    }

    // Create new question
    const result = await queryRun(`
      INSERT INTO quiz_questions (episode_id, question, options, correct_index, explanation, explanations, hint, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [episodeId, question, JSON.stringify(options), correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0])

    const count = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [episodeId])).c
    await queryRun('UPDATE courses SET quiz_count = ? WHERE episode_id = ?', [count, episodeId])

    res.json({ ok: true, id: result.insertId })
  } catch (err) { res.json({ ok: false, error: '保存失败' }) }
})

router.delete('/admin-quiz', authMiddleware, adminOnly, async (req, res) => {
  try {
    const q = await queryOne('SELECT episode_id FROM quiz_questions WHERE id = ?', [req.query.id])
    await queryRun('DELETE FROM quiz_questions WHERE id = ?', [req.query.id])
    if (q) {
      const count = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [q.episode_id])).c
      await queryRun('UPDATE courses SET quiz_count = ? WHERE episode_id = ?', [count, q.episode_id])
    }
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

export default router
