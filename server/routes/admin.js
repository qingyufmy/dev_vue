import { Router } from 'express'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { join, dirname, extname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { getDB } from '../db.js'
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
router.get('/admin-users', authMiddleware, adminOnly, (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query
    const db = getDB()
    const offset = (Number(page) - 1) * Number(limit)

    let where = '1=1'
    const params = []
    if (search) { where += ' AND (u.email LIKE ? OR u.nickname LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }

    // Get total user count
    const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c

    // Get today's new users
    const todayNewUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at) = date('now')").get().c

    // Get online stats (based on last_seen_at)
    let realtimeOnlineUsers = 0
    let todayOnlineUsers = 0
    let weekOnlineUsers = 0
    try {
      realtimeOnlineUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE datetime(last_seen_at) >= datetime('now', '-5 minutes')").get().c
      todayOnlineUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE datetime(last_seen_at) >= datetime('now', 'start of day')").get().c
      weekOnlineUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE datetime(last_seen_at) >= datetime('now', '-7 days')").get().c
    } catch {}

    // Get total revenue
    let totalRevenue = 0
    let paidOrderCount = 0
    try {
      const revenueRes = db.prepare("SELECT COALESCE(SUM(amount_confirmed), 0) as total, COUNT(*) as cnt FROM orders WHERE status = 'paid'").get()
      totalRevenue = Math.round(revenueRes.total / 100)
      paidOrderCount = revenueRes.cnt
    } catch {}

    // Get content stats
    let totalPosts = 0, totalComments = 0, totalReplies = 0
    try {
      totalPosts = db.prepare('SELECT COUNT(*) as c FROM posts').get().c
      totalComments = db.prepare('SELECT COUNT(*) as c FROM comments').get().c
      totalReplies = db.prepare('SELECT COUNT(*) as c FROM post_replies').get().c
    } catch {}

    // Get users with pagination
    const userCount = db.prepare(`SELECT COUNT(*) as c FROM users u WHERE ${where}`).get(...params).c
    const users = db.prepare(`
      SELECT u.id, u.uid, u.email, u.nickname, u.avatar, u.role, u.plan, u.plan_period, u.plan_expires_at,
             u.referral_code, u.referral_credit, u.telegram_id, u.created_at, u.last_seen_at
      FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset)

    // Enrich each user with progress, orders, and content counts
    const enrichedUsers = users.map(u => {
      // Get progress stats
      let progressData = { completed: 0, quizPassed: 0, total: 0 }
      try {
        const completed = db.prepare('SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND completed = 1').get(u.id).c
        const quizPassed = db.prepare('SELECT COUNT(*) as c FROM progress WHERE user_id = ? AND quiz_passed = 1').get(u.id).c
        const total = db.prepare('SELECT COUNT(*) as c FROM progress WHERE user_id = ?').get(u.id).c
        progressData = { completed, quizPassed, total }
      } catch {}

      // Get orders
      let orders = []
      try {
        orders = db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(u.id).map(o => ({
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
        totalPaid = db.prepare("SELECT COALESCE(SUM(amount_confirmed), 0) as t FROM orders WHERE user_id = ? AND status = 'paid'").get(u.id).t
      } catch {}

      // Get content counts
      let commentCount = 0, postCount = 0, replyCount = 0
      try {
        commentCount = db.prepare('SELECT COUNT(*) as c FROM comments WHERE user_id = ?').get(u.id).c
        postCount = db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ?').get(u.id).c
        replyCount = db.prepare('SELECT COUNT(*) as c FROM post_replies WHERE user_id = ?').get(u.id).c
      } catch {}

      // Get last activity
      let lastActivity = u.last_seen_at || null
      try {
        const lastComment = db.prepare('SELECT MAX(created_at) as m FROM comments WHERE user_id = ?').get(u.id).m
        const lastPost = db.prepare('SELECT MAX(created_at) as m FROM posts WHERE user_id = ?').get(u.id).m
        const lastReply = db.prepare('SELECT MAX(created_at) as m FROM post_replies WHERE user_id = ?').get(u.id).m
        lastActivity = [u.last_seen_at, lastComment, lastPost, lastReply].filter(Boolean).sort().pop() || null
      } catch {}

      return {
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
      }
    })

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
router.post('/admin-users', authMiddleware, adminOnly, (req, res) => {
  try {
    const { userId, plan, expiresAt, role, nickname } = req.body
    const db = getDB()

    if (plan) db.prepare("UPDATE users SET plan = ?, updated_at = datetime('now') WHERE id = ?").run(plan, userId)
    if (expiresAt !== undefined) db.prepare("UPDATE users SET plan_expires_at = ?, updated_at = datetime('now') WHERE id = ?").run(expiresAt, userId)
    if (role) db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, userId)
    if (nickname) db.prepare("UPDATE users SET nickname = ?, updated_at = datetime('now') WHERE id = ?").run(nickname, userId)

    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '更新失败' }) }
})

router.put('/admin-users', authMiddleware, adminOnly, (req, res) => {
  try {
    const { id, userId, role, plan, nickname, email, password, avatar, expiresAt } = req.body
    const uid = id || userId
    if (!uid) return res.json({ ok: false, error: '缺少用户ID' })
    const db = getDB()
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
    updates.push("updated_at = datetime('now')")
    params.push(uid)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)
    res.json({ ok: true })
  } catch (err) {
    console.error('Admin update user error:', err)
    res.json({ ok: false, error: '更新失败' })
  }
})

router.get('/admin-audit', authMiddleware, adminOnly, (req, res) => {
  try {
    const { page = 1, limit = 30, action, search, days } = req.query
    const db = getDB()
    const offset = (Number(page) - 1) * Number(limit)

    let where = '1=1'
    const params = []
    if (action && action !== 'all') { where += ' AND a.action = ?'; params.push(action) }
    if (search) { where += ' AND (a.user_email LIKE ? OR a.user_nickname LIKE ? OR a.detail LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`) }
    if (days && days !== 'all') {
      where += " AND a.created_at >= datetime('now', ?)"
      params.push(`-${Number(days)} days`)
    }

    const total = db.prepare(`SELECT COUNT(*) as c FROM audit_logs a WHERE ${where}`).get(...params).c
    const logs = db.prepare(`
      SELECT a.id, a.user_id, a.user_email, a.user_nickname, a.action, a.target_type, a.target_id,
             a.detail, a.ip, a.created_at
      FROM audit_logs a WHERE ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, Number(limit), offset)

    res.json({ ok: true, logs, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) })
  } catch (err) {
    console.error('Admin audit error:', err)
    res.json({ ok: false, error: '获取日志失败' })
  }
})

// Admin: referrals
router.get('/admin/referrals/overview', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const total = db.prepare('SELECT COUNT(*) as c FROM referrals').get().c
    const pending = db.prepare("SELECT COUNT(*) as c FROM referrals WHERE status = 'pending'").get().c
    const approved = db.prepare("SELECT COUNT(*) as c FROM referrals WHERE status = 'approved'").get().c
    const totalCommission = db.prepare('SELECT COALESCE(SUM(commission), 0) as c FROM referrals').get().c
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

router.get('/admin/referrals/commissions', authMiddleware, adminOnly, (req, res) => {
  try {
    const { status } = req.query
    const db = getDB()
    let where = '1=1'
    const params = []
    if (status) { where += ' AND r.status = ?'; params.push(status) }

    const rows = db.prepare(`
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
    `).all(...params)

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

router.put('/admin/referrals/commissions/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const { status, action } = req.body
    const db = getDB()
    const finalStatus = action === 'approve' ? 'approved' : action === 'void' ? 'voided' : status
    db.prepare("UPDATE referrals SET status = ?, commission = CASE WHEN ? = 'approved' THEN 500 ELSE 0 END WHERE id = ?").run(finalStatus, finalStatus, req.params.id)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '操作失败' }) }
})

router.patch('/admin/referrals/commissions/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const { status, action } = req.body
    const db = getDB()
    const finalStatus = action === 'approve' ? 'approved' : action === 'void' ? 'voided' : status
    db.prepare("UPDATE referrals SET status = ?, commission = CASE WHEN ? = 'approved' THEN 500 ELSE 0 END WHERE id = ?").run(finalStatus, finalStatus, req.params.id)
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
router.get('/admin-course-items', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const courses = db.prepare('SELECT * FROM courses ORDER BY sort_order').all()
    res.json({ ok: true, courses: courses.map(c => ({
      id: c.episode_id, episodeId: c.episode_id, number: c.number, title: c.title,
      description: c.description, category: c.category, contentType: c.content_type,
      duration: c.duration, youtubeId: c.youtube_id, bilibiliId: c.bilibili_id || '',
      cover: c.cover, gradient: c.gradient,
      articleUrl: c.article_url, articleObjectKey: c.article_object_key,
      accessLevel: c.access_level, hasStreamVideo: !!c.has_stream_video,
      quizCount: c.quiz_count, status: c.status, sortOrder: c.sort_order,
    })) })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-course-items', authMiddleware, adminOnly, (req, res) => {
  try {
    console.log('[AdminCourse] body:', JSON.stringify(req.body))
    const { episodeId, number, title, description, category, contentType, duration, youtubeId, bilibiliId, cover, accessLevel, sortOrder, articleUrl, articleObjectKey, status } = req.body
    console.log('[AdminCourse] episodeId:', episodeId, 'title:', title)
    const db = getDB()

    if (episodeId) {
      db.prepare(`
        UPDATE courses SET number=?, title=?, description=?, category=?, content_type=?, duration=?,
        youtube_id=?, bilibili_id=?, cover=?, access_level=?, sort_order=?, article_url=?, article_object_key=?,
        status=?, updated_at=datetime('now') WHERE episode_id=?
      `).run(number, title, description, category, contentType, duration, youtubeId || '', bilibiliId || '', cover, accessLevel, sortOrder, articleUrl, articleObjectKey, status, episodeId)
      const course = db.prepare('SELECT * FROM courses WHERE episode_id = ?').get(episodeId)
      res.json({ ok: true, course })
    } else {
      const maxId = db.prepare('SELECT MAX(episode_id) as m FROM courses').get().m || 0
      const result = db.prepare(`
        INSERT INTO courses (episode_id, number, title, description, category, content_type, duration, youtube_id, bilibili_id, cover, access_level, sort_order, article_url, article_object_key, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(maxId + 1, number || maxId + 1, title, description, category, contentType, duration, youtubeId || '', bilibiliId || '', cover, accessLevel, sortOrder, articleUrl, articleObjectKey, status || 'published')
      const course = db.prepare('SELECT * FROM courses WHERE episode_id = ?').get(maxId + 1)
      res.json({ ok: true, course })
    }
  } catch (err) { console.error('[AdminCourse] Error:', err); res.json({ ok: false, error: '保存失败' }) }
})

router.delete('/admin-course-items', authMiddleware, adminOnly, (req, res) => {
  try {
    const { episode } = req.query
    if (!episode) return res.json({ ok: false, error: '缺少课程ID' })
    const db = getDB()

    // Check if course exists
    const course = db.prepare('SELECT * FROM courses WHERE episode_id = ?').get(episode)
    if (!course) return res.json({ ok: false, error: '课程不存在' })

    // Delete related data
    db.prepare('DELETE FROM quiz_questions WHERE episode_id = ?').run(episode)
    db.prepare('DELETE FROM course_resources WHERE episode_id = ?').run(episode)
    db.prepare('DELETE FROM video_streams WHERE episode_id = ?').run(episode)
    db.prepare('DELETE FROM progress WHERE episode_id = ?').run(episode)
    db.prepare('DELETE FROM comments WHERE episode_id = ?').run(episode)
    db.prepare('DELETE FROM courses WHERE episode_id = ?').run(episode)

    res.json({ ok: true, message: '课程已删除' })
  } catch (err) {
    console.error('Delete course error:', err)
    res.json({ ok: false, error: '删除失败' })
  }
})

// Admin: course resources
router.get('/admin-course-resources', authMiddleware, adminOnly, (req, res) => {
  try {
    const { episode } = req.query
    const db = getDB()
    const resources = db.prepare('SELECT * FROM course_resources WHERE episode_id = ? ORDER BY sort_order').all(episode)
    const quizCount = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?').get(episode).c

    const assets = resources.map(r => ({
      id: r.id, type: r.type, title: r.title,
      assetType: r.type === 'mindmap' ? (r.structure ? 'mindmap_structure' : 'mindmap_image') : r.type,
    }))

    res.json({ ok: true, quizCount, assets, resources })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-course-resources', authMiddleware, adminOnly, resourceUpload.array('files', 50), (req, res) => {
  try {
    const episodeId = Number(req.body.episodeId)
    const includeQuiz = req.body.includeQuiz === '1'
    const includeMindmap = req.body.includeMindmap === '1'
    const includeInfographic = req.body.includeInfographic === '1'
    const files = req.files || []
    const db = getDB()

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

            db.prepare(`
              INSERT INTO quiz_questions (episode_id, question, options, answer, correct_index, explanation, explanations, hint, status, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
            `).run(
              episodeId,
              q.question,
              JSON.stringify(options),
              answer,
              answer,
              q.explanation || '',
              JSON.stringify(explanations),
              q.hint || '',
              inserted
            )
            inserted++
          }
          if (inserted > 0) {
            quizFiles++
            // Update quiz_count
            const count = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?').get(episodeId).c
            db.prepare('UPDATE courses SET quiz_count = ? WHERE episode_id = ?').run(count, episodeId)
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

            db.prepare(`
              INSERT INTO course_resources (episode_id, type, title, url, structure, sort_order)
              VALUES (?, 'mindmap', ?, ?, ?, ?)
            `).run(episodeId, structure.title || baseName, `/uploads/resources/ep${episodeId}/${baseName}`, content, assetFiles)
            assetFiles++
          } else if (isImageFile(baseName)) {
            // Mindmap image
            const ext = extname(baseName) || '.png'
            const saveName = `mindmap_${Date.now()}${ext}`
            writeFileSync(join(epDir, saveName), file.buffer)

            db.prepare(`
              INSERT INTO course_resources (episode_id, type, title, url, sort_order)
              VALUES (?, 'mindmap', ?, ?, ?)
            `).run(episodeId, baseName.replace(/\.[^.]+$/, ''), `/uploads/resources/ep${episodeId}/${saveName}`, assetFiles)
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

            db.prepare(`
              INSERT INTO course_resources (episode_id, type, title, url, sort_order)
              VALUES (?, 'knowledge', ?, ?, ?)
            `).run(episodeId, baseName.replace(/\.[^.]+$/, ''), `/uploads/resources/ep${episodeId}/${saveName}`, assetFiles)
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
              db.prepare(`
                INSERT INTO quiz_questions (episode_id, question, options, answer, correct_index, explanation, explanations, hint, status, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
              `).run(episodeId, q.question, JSON.stringify(options), answer, answer, q.explanation || '', JSON.stringify(q.explanations || []), q.hint || '', inserted)
              inserted++
            }
            if (inserted > 0) { quizFiles++; const c = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?').get(episodeId).c; db.prepare('UPDATE courses SET quiz_count = ? WHERE episode_id = ?').run(c, episodeId) }
          } else if (isImageFile(baseName) && (includeMindmap || includeInfographic)) {
            const ext = extname(baseName) || '.png'
            const saveName = `res_${Date.now()}${ext}`
            writeFileSync(join(epDir, saveName), file.buffer)
            const type = includeMindmap ? 'mindmap' : 'knowledge'
            db.prepare(`
              INSERT INTO course_resources (episode_id, type, title, url, sort_order)
              VALUES (?, ?, ?, ?, ?)
            `).run(episodeId, type, baseName.replace(/\.[^.]+$/, ''), `/uploads/resources/ep${episodeId}/${saveName}`, assetFiles)
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
    const mindmapCount = db.prepare("SELECT COUNT(*) as c FROM course_resources WHERE episode_id = ? AND type = 'mindmap'").get(episodeId).c
    const knowledgeCount = db.prepare("SELECT COUNT(*) as c FROM course_resources WHERE episode_id = ? AND type = 'knowledge'").get(episodeId).c
    db.prepare('UPDATE courses SET mindmap_count = ?, knowledge_count = ? WHERE episode_id = ?').run(mindmapCount, knowledgeCount, episodeId)

    res.json({ ok: true, quizFiles, assetFiles, skipped })
  } catch (err) {
    console.error('Resource upload error:', err)
    res.json({ ok: false, error: '上传失败: ' + err.message })
  }
})

// Admin: quiz
router.get('/admin-quiz', authMiddleware, adminOnly, (req, res) => {
  try {
    const { episode } = req.query
    const db = getDB()
    const questions = db.prepare('SELECT * FROM quiz_questions WHERE episode_id = ? ORDER BY sort_order').all(episode)
    res.json({ ok: true, questions: questions.map(q => ({
      id: q.id, question: q.question, options: JSON.parse(q.options || '[]'),
      answer: q.answer ?? q.correct_index, explanation: q.explanation,
      explanations: JSON.parse(q.explanations || '[]'), hint: q.hint,
      status: q.status, sortOrder: q.sort_order,
    })) })
  } catch (err) { res.json({ ok: false, error: '获取失败' }) }
})

router.post('/admin-quiz', authMiddleware, adminOnly, (req, res) => {
  try {
    const { id, episodeId, question, options, answer, correctIndex, explanation, explanations, hint, status, sortOrder } = req.body
    const db = getDB()

    // If id is provided, update existing question
    if (id) {
      db.prepare(`
        UPDATE quiz_questions SET question=?, options=?, answer=?, correct_index=?, explanation=?, explanations=?, hint=?, status=?, sort_order=? WHERE id=?
      `).run(question, JSON.stringify(options), answer ?? correctIndex ?? 0, correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0, id)

      // Update course quiz_count
      const q = db.prepare('SELECT episode_id FROM quiz_questions WHERE id = ?').get(id)
      if (q) {
        const count = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?').get(q.episode_id).c
        db.prepare('UPDATE courses SET quiz_count = ? WHERE episode_id = ?').run(count, q.episode_id)
      }

      return res.json({ ok: true, id })
    }

    // Create new question
    const result = db.prepare(`
      INSERT INTO quiz_questions (episode_id, question, options, answer, correct_index, explanation, explanations, hint, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(episodeId, question, JSON.stringify(options), answer ?? correctIndex ?? 0, correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0)

    const count = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?').get(episodeId).c
    db.prepare('UPDATE courses SET quiz_count = ? WHERE episode_id = ?').run(count, episodeId)

    res.json({ ok: true, id: result.lastInsertRowid })
  } catch (err) { res.json({ ok: false, error: '保存失败' }) }
})

router.put('/admin-quiz', authMiddleware, adminOnly, (req, res) => {
  try {
    const { id, question, options, answer, correctIndex, explanation, explanations, hint, status, sortOrder } = req.body
    const db = getDB()
    db.prepare(`
      UPDATE quiz_questions SET question=?, options=?, answer=?, correct_index=?, explanation=?, explanations=?, hint=?, status=?, sort_order=? WHERE id=?
    `).run(question, JSON.stringify(options), answer ?? correctIndex ?? 0, correctIndex ?? 0, explanation || '', JSON.stringify(explanations || []), hint || '', status || 'published', sortOrder || 0, id)
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '更新失败' }) }
})

router.delete('/admin-quiz', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const q = db.prepare('SELECT episode_id FROM quiz_questions WHERE id = ?').get(req.query.id)
    db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(req.query.id)
    if (q) {
      const count = db.prepare('SELECT COUNT(*) as c FROM quiz_questions WHERE episode_id = ?').get(q.episode_id).c
      db.prepare('UPDATE courses SET quiz_count = ? WHERE episode_id = ?').run(count, q.episode_id)
    }
    res.json({ ok: true })
  } catch (err) { res.json({ ok: false, error: '删除失败' }) }
})

export default router
