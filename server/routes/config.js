import { Router } from 'express'
import { getDB } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'

const router = Router()

// Public: get config by category (for toolbox and market menu)
router.get('/system-config-public/:category', (req, res) => {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id').all(req.params.category)
    res.json({ ok: true, items: rows })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Get all config (grouped by category)
router.get('/system-config', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT * FROM system_config ORDER BY category, sort_order, id').all()
    const grouped = {}
    for (const r of rows) {
      if (!grouped[r.category]) grouped[r.category] = []
      grouped[r.category].push(r)
    }
    res.json({ ok: true, config: grouped })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Get config by category
router.get('/system-config/:category', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id').all(req.params.category)
    res.json({ ok: true, items: rows })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Create or update config item
router.post('/system-config', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const { category, key, value, label, sort_order } = req.body
    if (!category || !key) return res.json({ ok: false, error: 'category 和 key 必填' })

    const existing = db.prepare('SELECT id FROM system_config WHERE category = ? AND key = ?').get(category, key)
    if (existing) {
      db.prepare('UPDATE system_config SET value = ?, label = ?, sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(value || '', label || '', sort_order || 0, existing.id)
      res.json({ ok: true, id: existing.id, action: 'updated' })
    } else {
      const result = db.prepare('INSERT INTO system_config (category, key, value, label, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(category, key, value || '', label || '', sort_order || 0)
      res.json({ ok: true, id: result.lastInsertRowid, action: 'created' })
    }
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Batch update config items
router.put('/system-config/:category', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    const { category } = req.params
    const { items } = req.body
    if (!Array.isArray(items)) return res.json({ ok: false, error: 'items 必须是数组' })

    const upsert = db.prepare(`
      INSERT INTO system_config (category, key, value, label, sort_order)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(category, key) DO UPDATE SET value = excluded.value, label = excluded.label, sort_order = excluded.sort_order, updated_at = datetime('now')
    `)

    const tx = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        upsert.run(category, item.key, item.value || '', item.label || '', item.sort_order ?? i)
      }
    })
    tx()

    res.json({ ok: true, count: items.length })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Delete config item
router.delete('/system-config/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    db.prepare('DELETE FROM system_config WHERE id = ?').run(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Delete all config in a category
router.delete('/system-config/category/:category', authMiddleware, adminOnly, (req, res) => {
  try {
    const db = getDB()
    db.prepare('DELETE FROM system_config WHERE category = ?').run(req.params.category)
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Send test email
router.post('/system-config/smtp/test', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { to } = req.body
    if (!to) return res.json({ ok: false, error: '请输入收件邮箱' })

    const db = getDB()
    const rows = db.prepare("SELECT key, value FROM system_config WHERE category = 'smtp'").all()
    const cfg = {}
    for (const r of rows) cfg[r.key] = r.value

    if (!cfg.host || !cfg.user) return res.json({ ok: false, error: '请先配置 SMTP 服务器和用户名' })

    const nodemailer = (await import('nodemailer')).default
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: Number(cfg.port) || 587,
      secure: cfg.secure === 'true',
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })

    await transporter.sendMail({
      from: { name: cfg.from_name || '街哥课堂', address: cfg.from || cfg.user },
      to,
      subject: '街哥课堂 - 测试邮件',
      html: `<div style="font-family:sans-serif;padding:20px;">
        <h2 style="color:#2563eb;">🎉 SMTP 配置成功！</h2>
        <p>这是一封来自<strong>街哥课堂</strong>的测试邮件。</p>
        <p>您的邮件服务已正常工作。</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
        <p style="color:#94a3b8;font-size:12px;">发送时间：${new Date().toLocaleString('zh-CN')}</p>
      </div>`,
    })

    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message || '发送失败' })
  }
})

export default router
