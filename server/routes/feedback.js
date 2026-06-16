import { Router } from 'express'
import nodemailer from 'nodemailer'
import { queryOne, queryAll, queryRun } from '../db.js'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'

function withAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ ok: false, error: '请先登录' })

  const token = authHeader.slice(7)
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    queryOne('SELECT id, email, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [decoded.userId])
      .then(user => {
        if (!user) return res.status(401).json({ ok: false, error: '用户不存在' })
        req.user = user
        next()
      })
      .catch(() => res.status(401).json({ ok: false, error: 'Token无效或已过期' }))
  } catch {
    return res.status(401).json({ ok: false, error: 'Token无效或已过期' })
  }
}

const router = Router()

const TYPE_LABELS = {
  feature: '功能建议',
  bug: 'Bug反馈',
  trading: '交易需求',
  course: '课程建议',
  other: '其他',
}

// POST /api/feedback — 提交需求反馈
router.post('/feedback', withAuth, async (req, res) => {
  try {
    const { type, title, description, contact } = req.body

    if (!type || !title || !description) {
      return res.status(400).json({ ok: false, error: '类型、标题和描述不能为空' })
    }
    if (!TYPE_LABELS[type]) {
      return res.status(400).json({ ok: false, error: '无效的反馈类型' })
    }
    if (title.length > 200) {
      return res.status(400).json({ ok: false, error: '标题不能超过200字' })
    }
    if (description.length > 5000) {
      return res.status(400).json({ ok: false, error: '描述不能超过5000字' })
    }

    // Save to DB
    const result = await queryRun(
      'INSERT INTO feedback (user_id, type, title, description, contact) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, type, title, description, contact || '']
    )
    const feedbackId = result.insertId

    // Load SMTP config
    const smtpConfig = {}
    const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
    for (const r of rows) smtpConfig[r.key] = r.value

    // Get admin email from users table (Plan A)
    let adminEmail = smtpConfig.from || smtpConfig.user
    const admin = await queryOne("SELECT email FROM users WHERE role = 'admin' LIMIT 1")
    if (admin) adminEmail = admin.email

    let emailSent = false
    if (smtpConfig.host && smtpConfig.user) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpConfig.host,
          port: Number(smtpConfig.port) || 587,
          secure: smtpConfig.secure === 'true',
          auth: { user: smtpConfig.user, pass: smtpConfig.pass },
          connectionTimeout: 10000,
          greetingTimeout: 8000,
        })

        const typeLabel = TYPE_LABELS[type]
        const userInfo = `${req.user.nickname || req.user.email} (${req.user.email})`

        await transporter.sendMail({
          from: { name: smtpConfig.from_name || '街哥课堂', address: smtpConfig.from || smtpConfig.user },
          to: adminEmail,
          subject: `[${typeLabel}] ${title}`,
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto">
              <h2 style="color:#d4af37;border-bottom:2px solid #d4af37;padding-bottom:8px">📨 ${typeLabel}</h2>
              <p><strong>标题：</strong>${title}</p>
              <p><strong>提交人：</strong>${userInfo}</p>
              <p><strong>联系方式：</strong>${contact || '未填写'}</p>
              <hr style="border:none;border-top:1px solid #333" />
              <div style="background:#f8f8f8;padding:16px;border-radius:8px;white-space:pre-wrap">${description.replace(/</g, '&lt;')}</div>
              <p style="color:#999;font-size:12px;margin-top:20px">反馈ID: #${feedbackId} · 来源: ${req.get('origin') || 'AURUM AI'}</p>
            </div>
          `
        })
        emailSent = true
      } catch (e) {
        console.error('Feedback email error:', e.message)
      }
    }

    res.json({
      ok: true,
      feedbackId,
      emailSent,
      message: emailSent
        ? '感谢你的反馈！'
        : '反馈已记录，我们会尽快查看。'
    })
  } catch (err) {
    console.error('POST /feedback error:', err)
    res.status(500).json({ ok: false, error: '提交失败，请稍后重试' })
  }
})

// GET /api/feedback/history — 当前用户的提交记录
router.get('/feedback/history', withAuth, async (req, res) => {
  try {
    const rows = await queryAll(
      'SELECT id, type, title, description, contact, created_at FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    )
    res.json({ ok: true, items: rows })
  } catch (err) {
    console.error('GET /feedback/history error:', err)
    res.status(500).json({ ok: false, error: '查询失败' })
  }
})

export default router
