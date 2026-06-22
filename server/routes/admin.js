import { Router } from 'express'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const resourceDir = join(__dirname, '..', 'uploads', 'resources')
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

// Admin: get users with full stats and enriched data
router.get('/admin-users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let where = '1=1'
    const params = []
    if (search) { where += ' AND (u.email LIKE ? OR u.nickname LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }

    // Get total user count
    const totalUsers = (await queryOne('SELECT COUNT(*) as c FROM users')).c

    // Get today's new users
    const todayNewUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE DATE(created_at) = CURDATE()')).c

    // Get online stats (based on last_seen_at)
    let realtimeOnlineUsers = 0
    let todayOnlineUsers = 0
    let weekOnlineUsers = 0
    try {
      realtimeOnlineUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)')).c
      todayOnlineUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE last_seen_at >= CURDATE()')).c
      weekOnlineUsers = (await queryOne('SELECT COUNT(*) as c FROM users WHERE YEARWEEK(last_seen_at, 1) = YEARWEEK(NOW(), 1)')).c
    } catch {}

    // Get total revenue
    let totalRevenue = 0
    let paidOrderCount = 0
    try {
      const revenueRes = await queryOne("SELECT COALESCE(SUM(amount_confirmed), 0) as total, COUNT(*) as cnt FROM orders WHERE status = 'paid'")
      totalRevenue = Math.round(revenueRes.total / 100)
      paidOrderCount = revenueRes.cnt
    } catch {}

    // Get content stats
    let totalPosts = 0, totalComments = 0, totalReplies = 0
    try {
      totalPosts = (await queryOne('SELECT COUNT(*) as c FROM posts')).c
      totalComments = (await queryOne('SELECT COUNT(*) as c FROM comments')).c
      totalReplies = (await queryOne('SELECT COUNT(*) as c FROM post_replies')).c
    } catch {}

    // Get users with pagination
    const userCount = (await queryOne(`SELECT COUNT(*) as c FROM users u WHERE ${where}`, params)).c
    const users = await queryAll(`
      SELECT u.id, u.uid, u.email, u.nickname, u.avatar, u.role, u.plan, u.plan_period, u.plan_expires_at,
             u.referral_code, u.referral_credit, u.telegram_id, u.created_at, u.last_seen_at
      FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset])

    // Enrich each user with progress, orders, and content counts
    const enrichedUsers = []
    for (const u of users) {
      // Get progress stats
      let progressData = { completed: 0, quizPassed: 0, total: 0 }
      try {
        const completed = (await queryOne('SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND completed = 1', [u.id])).c
        const quizPassed = (await queryOne('SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND quiz_passed = 1', [u.id])).c
        const total = (await queryOne('SELECT COUNT(*) as c FROM progress WHERE user_id = ?', [u.id])).c
        progressData = { completed, quizPassed, total }
      } catch {}

      // Get orders
      let orders = []
      try {
        const orderRows = await queryAll('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [u.id])
        orders = orderRows.map(o => ({
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
      } catch {}

      // Get total paid
      let totalPaid = 0
      try {
        totalPaid = (await queryOne("SELECT COALESCE(SUM(amount_confirmed), 0) as t FROM orders WHERE user_id = ? AND status = 'paid'", [u.id])).t
      } catch {}

      // Get content counts
      let commentCount = 0, postCount = 0, replyCount = 0
      try {
        commentCount = (await queryOne('SELECT COUNT(*) as c FROM comments WHERE user_id = ?', [u.id])).c
        postCount = (await queryOne('SELECT COUNT(*) as c FROM posts WHERE user_id = ?', [u.id])).c
        replyCount = (await queryOne('SELECT COUNT(*) as c FROM post_replies WHERE user_id = ?', [u.id])).c
      } catch {}

      // Get last activity
      let lastActivity = u.last_seen_at || null
      try {
        const lastComment = (await queryOne('SELECT MAX(created_at) as m FROM comments WHERE user_id = ?', [u.id])).m
        const lastPost = (await queryOne('SELECT MAX(created_at) as m FROM posts WHERE user_id = ?', [u.id])).m
        const lastReply = (await queryOne('SELECT MAX(created_at) as m FROM post_replies WHERE user_id = ?', [u.id])).m
        lastActivity = [u.last_seen_at, lastComment, lastPost, lastReply].filter(Boolean).sort().pop() || null
      } catch {}

      enrichedUsers.push({
        id: u.id,
        uid: u.uid || ('WS' + String(u.id).padStart(6, '0')),
        email: u.email,
        name: u.nickname || u.email.split('@')[0],
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
        orders,
        totalPaid,
        commentCount,
        postCount,
        replyCount,
        lastActivity,
      })
    }

    res.json({
      ok: true,
      stats: {
        totalUsers,
        todayNewUsers,
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

    if (plan) await queryRun('UPDATE users SET plan = ?, updated_at = NOW() WHERE id = ?', [plan, userId])
    if (expiresAt !== undefined) await queryRun('UPDATE users SET plan_expires_at = ?, updated_at = NOW() WHERE id = ?', [expiresAt, userId])
    if (role) await queryRun('UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?', [role, userId])
    if (nickname) await queryRun('UPDATE users SET nickname = ?, updated_at = NOW() WHERE id = ?', [nickname, userId])

    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '更新失败' }) }
})

router.put('/admin-users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id, userId, role, plan, nickname, email, password, avatar, expiresAt } = req.body
    const uid = id || userId
    if (!uid) return res.json({ ok: false, error: '缺少用户ID' })
    const updates = []
    const params = []
    if (email) { updates.push('email = ?'); params.push(email) }
    if (nickname) { updates.push('nickname = ?'); params.push(nickname) }
    if (password && password.length >= 6) { updates.push('password = ?'); params.push(bcrypt.hashSync(password, 10)) }
    if (avatar !== undefined) { updates.push('avatar = ?'); params.push(avatar) }
    if (role) { updates.push('role = ?'); params.push(role) }
    if (plan) {
      updates.push('plan = ?'); params.push(plan)
      if (plan === 'free') {
        updates.push('plan_expires_at = NULL')
      } else if (expiresAt) {
        updates.push('plan_expires_at = ?'); params.push(expiresAt)
      }
    }
    if (updates.length === 0) return res.json({ ok: false, error: '没有需要更新的字段' })
    updates.push('updated_at = NOW()')
    params.push(uid)
    await queryRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)
    res.json({ ok: true })
  } catch (err) {
    console.error('Admin update user error:', err)
    res.json({ ok: false, error: '更新失败' })
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
    const totalCommission = (await queryOne('SELECT COALESCE(SUM(commission), 0) as c FROM referrals')).c
    res.json({
      ok: true,
      total, pending, approved, totalCommission,
      stats: {
        total_invites: total,
        paid_invites: approved,
        pending_credit_cents: pending * 500,
        available_credit_cents: totalCommission,
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
      LEFT JOIN orders o ON o.user_id = r.referred_id AND o.status = 'paid'
      WHERE ${where} ORDER BY r.created_at DESC LIMIT 100
    `, params)

    const commissions = rows.map(r => ({
      id: r.id,
      referrer: { name: r.referrer_name, email: r.referrer_email, uid: r.referrer_uid },
      invited_user: { name: r.referred_name, email: r.referred_email, uid: r.referred_uid },
      order_id: r.order_id || null,
      plan: r.order_plan_label || r.plan_label || '',
      period: r.order_period_label || '',
      source_cash_amount_cents: r.order_amount_confirmed || r.amount_cents || 0,
      amount_cents: r.commission || 0,
      rate_bps: r.amount_cents > 0 ? Math.round((r.commission / r.amount_cents) * 10000) : 500,
      status: r.status,
      available_at: r.attributed_at || r.created_at,
      created_at: r.created_at,
    }))

    res.json({ ok: true, commissions })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.put('/admin/referrals/commissions/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, action } = req.body
    const finalStatus = action === 'approve' ? 'approved' : action === 'void' ? 'voided' : status
    await queryRun("UPDATE referrals SET status = ?, commission = CASE WHEN ? = 'approved' THEN 500 ELSE 0 END WHERE id = ?", [finalStatus, finalStatus, req.params.id])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.patch('/admin/referrals/commissions/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, action } = req.body
    const finalStatus = action === 'approve' ? 'approved' : action === 'void' ? 'voided' : status
    await queryRun("UPDATE referrals SET status = ?, commission = CASE WHEN ? = 'approved' THEN 500 ELSE 0 END WHERE id = ?", [finalStatus, finalStatus, req.params.id])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.get('/admin/referrals/rules', authMiddleware, adminOnly, (req, res) => {
  res.json({
    ok: true,
    rules: [
      { plan: 'plus', period: 'monthly', rate_bps: 1000, enabled: 1 },
      { plan: 'plus', period: 'yearly', rate_bps: 1000, enabled: 1 },
      { plan: 'pro', period: 'monthly', rate_bps: 1000, enabled: 1 },
      { plan: 'pro', period: 'yearly', rate_bps: 1000, enabled: 1 },
    ],
  })
})

router.put('/admin/referrals/rules', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, message: '规则已更新' })
})

router.patch('/admin/referrals/rules', authMiddleware, adminOnly, (req, res) => {
  res.json({ ok: true, message: '规则已更新' })
})

// Admin: course items
router.get('/admin-course-items', authMiddleware, adminOnly, async (req, res) => {
  try {
    const courses = await queryAll('SELECT * FROM courses ORDER BY created_at DESC')
    res.json({ ok: true, courses: courses.map(c => ({
      id: c.episode_id, episodeId: c.episode_id, number: c.number, title: c.title,
      description: c.description, category: c.category, contentType: c.content_type,
      duration: c.duration, youtubeId: c.youtube_id, bilibiliId: c.bilibili_id || '',
      cover: c.cover, gradient: c.gradient,
      articleUrl: c.article_url, articleObjectKey: c.article_object_key,
      accessLevel: c.access_level, hasStreamVideo: !!c.has_stream_video,
      quizCount: c.quiz_count, status: c.status, sortOrder: c.sort_order,
      createdAt: c.created_at, updatedAt: c.updated_at,
    })) })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-course-items', authMiddleware, adminOnly, async (req, res) => {
  try {
    console.log('[AdminCourse] body:', JSON.stringify(req.body))
    const { episodeId, number, title, description, category, contentType, duration, youtubeId, bilibiliId, cover, accessLevel, sortOrder, articleUrl, articleObjectKey, status } = req.body
    console.log('[AdminCourse] episodeId:', episodeId, 'title:', title)

    // Shared: auto-fetch Bilibili cover + duration
    let finalCover = cover, finalDuration = duration
    if (bilibiliId) {
      try {
        const bi = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bilibiliId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' }
        })
        const bd = await bi.json()
        if (bd.code === 0 && bd.data) {
          if (bd.data.pic) finalCover = bd.data.pic.replace('http://', 'https://')
          if ((!duration || duration === '') && bd.data.duration) finalDuration = bd.data.duration
        }
      } catch {}
    }

    if (episodeId) {
      await queryRun(`
        UPDATE courses SET number=?, title=?, description=?, category=?, content_type=?, duration=?,
        youtube_id=?, bilibili_id=?, cover=?, access_level=?, sort_order=?, article_url=?, article_object_key=?,
        status=?, updated_at=NOW() WHERE episode_id=?
      `, [number, title, description, category, contentType, finalDuration, youtubeId || '', bilibiliId || '', finalCover, accessLevel, sortOrder, articleUrl, articleObjectKey, status, episodeId])
      const course = await queryOne('SELECT * FROM courses WHERE episode_id = ?', [episodeId])
      res.json({ ok: true, course })
    } else {
      const maxRow = await queryOne('SELECT MAX(episode_id) as m FROM courses')
      const maxId = maxRow?.m || 0
      await queryRun(`
        INSERT INTO courses (episode_id, number, title, description, category, content_type, duration, youtube_id, bilibili_id, cover, access_level, sort_order, article_url, article_object_key, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [maxId + 1, number || maxId + 1, title, description, category, contentType, finalDuration, youtubeId || '', bilibiliId || '', finalCover, accessLevel, sortOrder, articleUrl, articleObjectKey, status || 'published'])
      const course = await queryOne('SELECT * FROM courses WHERE episode_id = ?', [maxId + 1])
      res.json({ ok: true, course })
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

    // Delete related data
    await queryRun('DELETE FROM quiz_questions WHERE episode_id = ?', [episode])
    await queryRun('DELETE FROM course_resources WHERE episode_id = ?', [episode])
    await queryRun('DELETE FROM video_streams WHERE episode_id = ?', [episode])
    await queryRun('DELETE FROM progress WHERE episode_id = ?', [episode])
    await queryRun('DELETE FROM comments WHERE episode_id = ?', [episode])
    await queryRun('DELETE FROM courses WHERE episode_id = ?', [episode])

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

    const assets = resources.map(r => ({
      id: r.id, type: r.type, title: r.title,
      assetType: r.type === 'mindmap' ? (r.structure ? 'mindmap_structure' : 'mindmap_image') : r.type,
    }))

    res.json({ ok: true, quizCount, assets, resources })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
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
      const baseName = relPath.replace(/^[^/]+\//, '') // Remove folder prefix

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
              INSERT INTO quiz_questions (episode_id, question, options, answer, correct_index, explanation, explanations, hint, status, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
            `, [
              episodeId,
              q.question,
              JSON.stringify(options),
              answer,
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
                INSERT INTO quiz_questions (episode_id, question, options, answer, correct_index, explanation, explanations, hint, status, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
              `, [episodeId, q.question, JSON.stringify(options), answer, answer, q.explanation || '', JSON.stringify(q.explanations || []), q.hint || '', inserted])
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
    res.json({ ok: false, error: '上传失败: ' + err.message })
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
        UPDATE quiz_questions SET question=?, options=?, answer=?, correct_index=?, explanation=?, explanations=?, hint=?, status=?, sort_order=? WHERE id=?
      `, [question, JSON.stringify(options), answer ?? correctIndex ?? 0, correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0, id])

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
      INSERT INTO quiz_questions (episode_id, question, options, answer, correct_index, explanation, explanations, hint, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [episodeId, question, JSON.stringify(options), answer ?? correctIndex ?? 0, correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0])

    const count = (await queryOne('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?', [episodeId])).c
    await queryRun('UPDATE courses SET quiz_count = ? WHERE episode_id = ?', [count, episodeId])

    res.json({ ok: true, id: result.insertId })
  } catch (err) { res.json({ ok: false, error: '保存失败' }) }
})

router.put('/admin-quiz', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id, question, options, answer, correctIndex, explanation, explanations, hint, status, sortOrder } = req.body
    await queryRun(`
      UPDATE quiz_questions SET question=?, options=?, answer=?, correct_index=?, explanation=?, explanations=?, hint=?, status=?, sort_order=? WHERE id=?
    `, [question, JSON.stringify(options), answer ?? correctIndex ?? 0, correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0, id])
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '更新失败' }) }
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
