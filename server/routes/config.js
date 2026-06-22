import { Router } from 'express'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'

const router = Router()

// Public: get config by category (for toolbox and market menu)
router.get('/system-config-public/:category', async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id', [req.params.category])
    res.json({ ok: true, items: rows })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Get all config (grouped by category)
router.get('/system-config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM system_config ORDER BY category, sort_order, id')
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
router.get('/system-config/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id', [req.params.category])
    res.json({ ok: true, items: rows })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Create or update config item
router.post('/system-config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category, key, value, label, sort_order } = req.body
    if (!category || !key) return res.json({ ok: false, error: 'category 和 key 必填' })

    const existing = await queryOne('SELECT id FROM system_config WHERE category = ? AND `key` = ?', [category, key])
    if (existing) {
      await queryRun('UPDATE system_config SET `value` = ?, label = ?, sort_order = ?, updated_at = NOW() WHERE id = ?',
        [value || '', label || '', sort_order || 0, existing.id])
      res.json({ ok: true, id: existing.id, action: 'updated' })
    } else {
      const result = await queryRun('INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)',
        [category, key, value || '', label || '', sort_order || 0])
      res.json({ ok: true, id: result.insertId, action: 'created' })
    }
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Batch update config items
router.put('/system-config/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category } = req.params
    const { items } = req.body
    if (!Array.isArray(items)) return res.json({ ok: false, error: 'items 必须是数组' })

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      await queryRun(`
        INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), label = VALUES(label), sort_order = VALUES(sort_order), updated_at = NOW()
      `, [category, item.key, item.value || '', item.label || '', item.sort_order ?? i])
    }

    res.json({ ok: true, count: items.length })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Delete config item
router.delete('/system-config/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await queryRun('DELETE FROM system_config WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Delete all config in a category
router.delete('/system-config/category/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    await queryRun('DELETE FROM system_config WHERE category = ?', [req.params.category])
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

    const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
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

// ===== Site Updates (public) =====
// Get recent site updates for sidebar display
router.get('/site-updates', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20)
    const rows = await queryAll(
      'SELECT id, date, icon, title, content, target_type, target_id, target_url FROM site_updates ORDER BY date DESC, sort_order DESC, id DESC LIMIT ?',
      [limit]
    )
    // Transform to match frontend expected format
    const items = rows.map(r => {
      const target = {}
      if (r.target_type === 'path' || r.target_type === 'category') {
        target.type = r.target_type
        if (r.target_url) target.url = r.target_url
        if (r.target_id) target.id = r.target_id
      } else if (r.target_type && r.target_id) {
        target.type = r.target_type
        target.id = r.target_id
        if (r.target_url) target.url = r.target_url
      } else if (r.target_url) {
        target.url = r.target_url
      }
      const tgt = Object.keys(target).length ? target : undefined
      return { id: r.id, date: r.date, icon: r.icon, title: r.title, content: r.content, target: tgt }
    })
    res.json({ ok: true, items })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Admin: add site update
router.post('/site-updates', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { date, icon, title, content, target_type, target_id, target_url } = req.body
    if (!date || !title) return res.json({ ok: false, error: '日期和标题必填' })
    await queryRun(
      'INSERT INTO site_updates (date, icon, title, content, target_type, target_id, target_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [date, icon || '·', title, content || '', target_type || null, target_id || null, target_url || null]
    )
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Admin: update site update
router.put('/site-updates/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { date, icon, title, content, target_type, target_id, target_url } = req.body
    const fields = []; const values = []
    if (date !== undefined) { fields.push('date = ?'); values.push(date) }
    if (icon !== undefined) { fields.push('icon = ?'); values.push(icon) }
    if (title !== undefined) { fields.push('title = ?'); values.push(title) }
    if (content !== undefined) { fields.push('content = ?'); values.push(content) }
    if (target_type !== undefined) { fields.push('target_type = ?'); values.push(target_type) }
    if (target_id !== undefined) { fields.push('target_id = ?'); values.push(target_id) }
    if (target_url !== undefined) { fields.push('target_url = ?'); values.push(target_url) }
    if (!fields.length) return res.json({ ok: false, error: '没有可更新的字段' })
    values.push(req.params.id)
    await queryRun(`UPDATE site_updates SET ${fields.join(', ')} WHERE id = ?`, values)
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

// Admin: delete site update
router.delete('/site-updates/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await queryRun('DELETE FROM site_updates WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: err.message })
  }
})

export default router
