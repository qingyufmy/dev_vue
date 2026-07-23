import { Router } from 'express'
import { queryOne, queryAll, queryRun } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { resetFixedAddressCache } from '../crypto/fixed-address.js'
import { resetSmsConfigCache } from '../sms.js'

const router = Router()

// 仅允许这些公开类别，敏感类别（smtp、qiniu、ai_provider 等）不可通过此接口访问
const PUBLIC_CATEGORIES = new Set(['toolbox', 'market_menu', 'announcements', 'features', 'auth_toggle'])

const SENSITIVE_KEY_RE = /mnemonic|private_key|secret|password|access_key/i
function redactItems(items) {
  return items.map(it => SENSITIVE_KEY_RE.test(it.key)
    ? { ...it, value: it.value ? '***REDACTED***' : it.value }
    : it)
}

// Public: get config by category (for toolbox and market menu)
router.get('/system-config-public/:category', async (req, res) => {
  const category = req.params.category
  if (!PUBLIC_CATEGORIES.has(category)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }
  try {
    const items = await queryAll('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id', [category])
    res.json({ ok: true, items })
  } catch (err) {
    console.error('[Config] Public config error:', err)
    res.json({ ok: false, error: '加载失败' })
  }
})

// Public: get current changelog version + content
router.get('/changelog/current', async (req, res) => {
  try {
    const versionRow = await queryOne("SELECT `value` FROM system_config WHERE category = 'changelog' AND `key` = 'version'")
    const contentRow = await queryOne("SELECT `value` FROM system_config WHERE category = 'changelog' AND `key` = 'content'")
    res.json({
      ok: true,
      version: parseInt(versionRow?.value || '1', 10),
      content: contentRow?.value || ''
    })
  } catch (err) {
    console.error('[Config] Changelog error:', err)
    res.json({ ok: true, version: 1, content: '' })
  }
})

// Admin: get changelog
router.get('/admin/release-notes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const versionRow = await queryOne("SELECT `value` FROM system_config WHERE category = 'changelog' AND `key` = 'version'")
    const contentRow = await queryOne("SELECT `value` FROM system_config WHERE category = 'changelog' AND `key` = 'content'")
    res.json({ ok: true, version: parseInt(versionRow?.value || '1', 10), content: contentRow?.value || '' })
  } catch (err) {
    console.error('[Config] Get changelog error:', err)
    res.json({ ok: false, error: '读取失败' })
  }
})

// Admin: update changelog
router.post('/admin/release-notes', authMiddleware, adminOnly, async (req, res) => {
  const { version, content } = req.body
  if (version === undefined || version === null) {
    return res.json({ ok: false, error: '版本号必填' })
  }
  try {
    const verStr = String(parseInt(version, 10))
    const existing = await queryOne("SELECT id FROM system_config WHERE category = 'changelog' AND `key` = 'version'")
    if (existing) {
      await queryRun("UPDATE system_config SET `value` = ? WHERE category = 'changelog' AND `key` = 'version'", [verStr])
    } else {
      await queryRun("INSERT INTO system_config (category, `key`, `value`, label) VALUES (?, ?, ?, ?)", ['changelog', 'version', verStr, '当前版本号'])
    }
    if (content !== undefined) {
      const existingContent = await queryOne("SELECT id FROM system_config WHERE category = 'changelog' AND `key` = 'content'")
      if (existingContent) {
        await queryRun("UPDATE system_config SET `value` = ? WHERE category = 'changelog' AND `key` = 'content'", [content])
      } else {
        await queryRun("INSERT INTO system_config (category, `key`, `value`, label) VALUES (?, ?, ?, ?)", ['changelog', 'content', content, '更新日志内容（HTML）'])
      }
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] Update changelog error:', err)
    res.json({ ok: false, error: '更新失败' })
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
    // 对每个类别脱敏敏感字段
    for (const cat of Object.keys(grouped)) {
      grouped[cat] = redactItems(grouped[cat])
    }
    res.json({ ok: true, config: grouped })
  } catch (err) {
    console.error('[Config] Load config error:', err)
    res.json({ ok: false, error: '加载配置失败' })
  }
})

// Get config by category
router.get('/system-config/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id', [req.params.category])
    res.json({ ok: true, items: redactItems(rows) })
  } catch (err) {
    console.error('[Config] Load category error:', err)
    res.json({ ok: false, error: '加载配置失败' })
  }
})

// Create or update config item
router.post('/system-config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category, key, value, label, sort_order } = req.body
    if (!category || !key) return res.json({ ok: false, error: 'category 和 key 必填' })
    if (value === '***REDACTED***') return res.json({ ok: false, error: '敏感字段不可通过此方式更新' })

    const existing = await queryOne('SELECT id FROM system_config WHERE category = ? AND `key` = ?', [category, key])
    if (existing) {
      await queryRun('UPDATE system_config SET `value` = ?, label = ?, sort_order = ?, updated_at = NOW() WHERE id = ?',
        [value || '', label || '', sort_order || 0, existing.id])
    } else {
      await queryRun('INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)',
        [category, key, value || '', label || '', sort_order || 0])
    }
    if (category === 'crypto_wallet') resetFixedAddressCache()
    if (category === 'sms') resetSmsConfigCache()
    res.json({ ok: true, id: existing?.id, action: existing ? 'updated' : 'created' })
  } catch (err) {
    console.error('[Config] Save config error:', err)
    res.json({ ok: false, error: '保存配置失败' })
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
      if (item.value === '***REDACTED***') continue
      await queryRun(`
        INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), label = VALUES(label), sort_order = VALUES(sort_order), updated_at = NOW()
      `, [category, item.key, item.value || '', item.label || '', item.sort_order ?? i])
    }
    if (category === 'crypto_wallet') resetFixedAddressCache()
    if (category === 'sms') resetSmsConfigCache()
    res.json({ ok: true, count: items.length })
  } catch (err) {
    console.error('[Config] Batch update error:', err)
    res.json({ ok: false, error: '批量更新失败' })
  }
})

// Delete config item
router.delete('/system-config/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Get category before delete to invalidate cache
    const item = await queryOne('SELECT category FROM system_config WHERE id = ?', [req.params.id])
    await queryRun('DELETE FROM system_config WHERE id = ?', [req.params.id])
    if (item?.category === 'crypto_wallet') resetFixedAddressCache()
    if (item?.category === 'sms') resetSmsConfigCache()
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] Delete config error:', err)
    res.json({ ok: false, error: '删除失败' })
  }
})

// Delete all config in a category
router.delete('/system-config/category/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    await queryRun('DELETE FROM system_config WHERE category = ?', [req.params.category])
    if (req.params.category === 'crypto_wallet') resetFixedAddressCache()
    if (req.params.category === 'sms') resetSmsConfigCache()
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] Delete category error:', err)
    res.json({ ok: false, error: '删除分类失败' })
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
      from: { name: cfg.from_name || '量见课堂', address: cfg.from || cfg.user },
      to,
      subject: '量见课堂 - 测试邮件',
      html: `<div style="font-family:sans-serif;padding:20px;">
        <h2 style="color:#2563eb;">🎉 SMTP 配置成功！</h2>
        <p>这是一封来自<strong>量见课堂</strong>的测试邮件。</p>
        <p>您的邮件服务已正常工作。</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
        <p style="color:#94a3b8;font-size:12px;">发送时间：${new Date().toLocaleString('zh-CN')}</p>
      </div>`,
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] SMTP test error:', err)
    res.json({ ok: false, error: '邮件发送失败' })
  }
})

// Send test SMS
router.post('/system-config/sms/test', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { to, template } = req.body
    if (!to) return res.json({ ok: false, error: '请输入测试手机号' })

    const { sendSms, loadSmsConfig } = await import('../sms.js')
    const cfg = await loadSmsConfig()
    if (!cfg.accessKeyId || !cfg.accessKeySecret) {
      return res.json({ ok: false, error: '请先配置阿里云 AccessKey' })
    }
    if (!cfg.signName) {
      return res.json({ ok: false, error: '请先配置短信签名' })
    }

    const isMembershipExpiry = template === 'membership_expiry'
    const isMembershipExpired = template === 'membership_expired'
    const templateCode = isMembershipExpired
      ? cfg.templateCodes?.membership_expired
      : isMembershipExpiry ? cfg.templateCodes?.membership_expiry : cfg.templateCodes?.login || cfg.templateCodes?.register
    if (!templateCode) {
      const error = isMembershipExpired ? '请先配置会员已过期提醒模板'
        : isMembershipExpiry ? '请先配置会员到期提醒模板' : '请先配置短信模板'
      return res.json({ ok: false, error })
    }

    const params = isMembershipExpired
      ? { plan:'Pro', expire_date:'2026-07-30' }
      : isMembershipExpiry ? { plan:'Pro', expire_date:'2026-07-30', days:'7' }
      : { code:'123456' }
    await sendSms(to, templateCode, params)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] SMS test error:', err)
    res.json({ ok: false, error: '短信发送失败' })
  }
})

// ===== Site Updates (from latest courses) =====
router.get('/site-updates', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20)
    const rows = await queryAll(
      'SELECT id, episode_id, number, title, category, content_type, created_at FROM courses WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      ['published', limit]
    )
    const items = rows.map(r => {
      const episodeId = r.episode_id || r.id
      const label = r.number ? `第${r.number}期 · ${r.title}` : r.title
      const icon = r.content_type === 'article' ? '📖' : '🎬'
      return {
        date: r.created_at ? r.created_at.substring(0, 10) : '',
        icon,
        title: label,
        target: { type: 'episode', id: episodeId }
      }
    })
    res.json({ ok: true, items })
  } catch (err) {
    console.error('[Config] Site updates error:', err)
    res.json({ ok: false, error: '加载更新失败' })
  }
})

export default router
