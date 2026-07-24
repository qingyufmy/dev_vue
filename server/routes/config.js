import { Router } from 'express'
import { queryOne, queryAll, queryRun, logAudit } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { resetFixedAddressCache } from '../crypto/fixed-address.js'
import { resetSmsConfigCache } from '../sms.js'
import { validateAddress } from '../crypto/wallet.js'
import { isEncryptionAvailable } from '../ai-credential.js'
import { isSensitiveSystemConfigKey, protectSystemConfigValue, systemConfigRowsToMap } from '../system-config-secrets.js'

const router = Router()

// 仅允许这些公开类别，敏感类别（smtp、qiniu、ai_provider 等）不可通过此接口访问
const PUBLIC_CATEGORIES = new Set(['toolbox', 'market_menu', 'announcements', 'features', 'auth_toggle'])

const BOOLEAN_VALUES = new Set(['true', 'false'])
const ADMIN_CONFIG_SCHEMA = Object.freeze({
  auth_toggle:{ label:'登录与注册', source:'database', apply_mode:'immediate', keys:{
    email_enabled:{ type:'boolean', default:'true' }, phone_enabled:{ type:'boolean', default:'true' },
    gift_enabled:{ type:'boolean', default:'true' }, gift_plan:{ type:'enum', values:['free','plus','pro'], default:'pro' },
    gift_duration:{ type:'integer', min:1, max:3650, default:'30' }, gift_duration_unit:{ type:'enum', values:['days','months','years'], default:'days' },
  }},
  plan_prices:{ label:'套餐价格', source:'database', apply_mode:'immediate', keys:{
    plus_month:{ type:'integer', min:1, max:1000000 }, plus_month_original:{ type:'integer', min:0, max:1000000 },
    plus_year:{ type:'integer', min:1, max:1000000 }, plus_year_original:{ type:'integer', min:0, max:1000000 },
    pro_month:{ type:'integer', min:1, max:1000000 }, pro_month_original:{ type:'integer', min:0, max:1000000 },
    pro_year:{ type:'integer', min:1, max:1000000 }, pro_year_original:{ type:'integer', min:0, max:1000000 },
  }},
  crypto_wallet:{ label:'TRC-20 收款', source:'database', apply_mode:'immediate', keys:{
    payment_mode:{ type:'enum', values:['fixed'], default:'fixed', read_only:true },
    fixed_tron_address:{ type:'tron_address' },
  }},
  sms:{ label:'短信服务', source:'database_encrypted', apply_mode:'immediate', keys:{
    access_key_id:{ type:'secret' }, access_key_secret:{ type:'secret' }, sign_name:{ type:'string', max:100 },
    template_code:{ type:'string', max:100 }, test_phone:{ type:'string', max:30 }, template_code_login:{ type:'string', max:100 },
    template_code_register:{ type:'string', max:100 }, template_code_reset:{ type:'string', max:100 }, template_code_bind:{ type:'string', max:100 },
    template_code_membership_expiry:{ type:'string', max:100 }, template_code_membership_expired:{ type:'string', max:100 },
  }},
  smtp:{ label:'发件邮箱', source:'database_encrypted', apply_mode:'immediate', keys:{
    host:{ type:'string', max:255 }, port:{ type:'integer', min:1, max:65535, default:'587' }, user:{ type:'string', max:255 },
    pass:{ type:'secret' }, from:{ type:'email', max:255 }, from_name:{ type:'string', max:100 }, secure:{ type:'boolean', default:'false' },
  }},
  market_menu:{ label:'股票研究菜单', source:'database', apply_mode:'immediate', keys:{ items:{ type:'json_array', max:500000, default:'[]' } }},
  toolbox:{ label:'金融工具箱', source:'database', apply_mode:'immediate', keys:{ items:{ type:'json_array', max:500000, default:'[]' } }},
})

function schemaFor(category, key) { return ADMIN_CONFIG_SCHEMA[category]?.keys?.[key] || null }
function normalizeConfigValue(category, key, value) {
  const meta = schemaFor(category, key)
  if (!meta) throw new Error('config_key_not_allowed')
  const text = String(value ?? '').trim()
  if (meta.read_only) {
    const locked = String(meta.default ?? '')
    if (text !== locked) throw new Error('config_read_only')
    return locked
  }
  if (meta.type === 'boolean') {
    if (!BOOLEAN_VALUES.has(text)) throw new Error('config_boolean_invalid')
    return text
  }
  if (meta.type === 'enum') {
    if (!meta.values.includes(text)) throw new Error('config_enum_invalid')
    return text
  }
  if (meta.type === 'integer') {
    if (!/^-?\d+$/.test(text)) throw new Error('config_integer_invalid')
    const number = Number(text)
    if (!Number.isSafeInteger(number) || number < meta.min || number > meta.max) throw new Error('config_integer_out_of_range')
    return String(number)
  }
  if (meta.type === 'tron_address') {
    if (!validateAddress('TRON', text)) throw new Error('config_tron_address_invalid')
    return text
  }
  if (meta.type === 'json_array') {
    if (text.length > meta.max) throw new Error('config_json_too_large')
    let parsed
    try { parsed = JSON.parse(text || '[]') } catch { throw new Error('config_json_invalid') }
    if (!Array.isArray(parsed)) throw new Error('config_json_array_required')
    return JSON.stringify(parsed)
  }
  if (meta.type === 'email' && text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new Error('config_email_invalid')
  if (meta.max && text.length > meta.max) throw new Error('config_text_too_long')
  return text
}

function configErrorMessage(error) {
  const messages = {
    config_category_not_allowed:'该配置分类不可在后台修改', config_key_not_allowed:'该配置项不可在后台修改', config_read_only:'该配置由执行合约锁定，不可修改',
    config_boolean_invalid:'开关值无效', config_enum_invalid:'选项值无效', config_integer_invalid:'请输入整数',
    config_integer_out_of_range:'数值超出允许范围', config_tron_address_invalid:'TRON 收款地址格式无效',
    config_json_invalid:'JSON 格式无效', config_json_array_required:'配置内容必须是数组', config_json_too_large:'配置内容过大',
    config_email_invalid:'邮箱格式无效', config_text_too_long:'配置内容过长',
    credential_encryption_unavailable:'凭证加密服务未就绪，敏感配置未保存',
  }
  return messages[error?.message] || '配置校验失败'
}

function redactItems(items) {
  return items.map(it => isSensitiveSystemConfigKey(it.key)
    ? { ...it, value: it.value ? '***REDACTED***' : it.value }
    : it)
}

function serializeAdminConfig(rows) {
  const byKey = new Map(rows.map(row => [`${row.category}:${row.key}`, row]))
  const grouped = {}
  for (const [category, categoryMeta] of Object.entries(ADMIN_CONFIG_SCHEMA)) {
    grouped[category] = Object.entries(categoryMeta.keys).map(([key, keyMeta], index) => {
      const row = byKey.get(`${category}:${key}`) || { id:null, category, key, value:keyMeta.default ?? '', label:'', sort_order:index, created_at:null, updated_at:null }
      const redacted = redactItems([row])[0]
      return { ...redacted, config_meta:{ type:keyMeta.type, source:categoryMeta.source, apply_mode:categoryMeta.apply_mode,
        editable:!keyMeta.read_only, sensitive:isSensitiveSystemConfigKey(key), min:keyMeta.min, max:keyMeta.max } }
    })
  }
  return grouped
}

async function auditConfigChange(req, action, category, keys = []) {
  await logAudit({ userId:req.user.id, action, targetType:'system_config', detail:JSON.stringify({ category, keys }), ip:req.ip, userAgent:req.get('user-agent') })
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
    res.json({ ok: true, config:serializeAdminConfig(rows), security:{ credential_encryption_available:isEncryptionAvailable() } })
  } catch (err) {
    console.error('[Config] Load config error:', err)
    res.json({ ok: false, error: '加载配置失败' })
  }
})

// Get config by category
router.get('/system-config/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!ADMIN_CONFIG_SCHEMA[req.params.category]) return res.status(404).json({ ok:false, error:'配置分类不存在' })
    const rows = await queryAll('SELECT * FROM system_config WHERE category = ? ORDER BY sort_order, id', [req.params.category])
    res.json({ ok: true, items: serializeAdminConfig(rows)[req.params.category] || [] })
  } catch (err) {
    console.error('[Config] Load category error:', err)
    res.json({ ok: false, error: '加载配置失败' })
  }
})

// Create or update config item
router.post('/system-config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category, key, value, label, sort_order } = req.body
    if (!category || !key) return res.status(400).json({ ok: false, error: 'category 和 key 必填' })
    if (!ADMIN_CONFIG_SCHEMA[category]) throw new Error('config_category_not_allowed')
    if (value === '***REDACTED***') return res.json({ ok: false, error: '敏感字段不可通过此方式更新' })
    const normalized = normalizeConfigValue(category, key, value)
    const storedValue = protectSystemConfigValue(key, normalized)

    const existing = await queryOne('SELECT id FROM system_config WHERE category = ? AND `key` = ?', [category, key])
    if (existing) {
      await queryRun('UPDATE system_config SET `value` = ?, label = ?, sort_order = ?, updated_at = NOW() WHERE id = ?',
        [storedValue, label || '', sort_order || 0, existing.id])
    } else {
      await queryRun('INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)',
        [category, key, storedValue, label || '', sort_order || 0])
    }
    if (category === 'crypto_wallet') resetFixedAddressCache()
    if (category === 'sms') resetSmsConfigCache()
    await auditConfigChange(req, 'system_config_updated', category, [key])
    res.json({ ok: true, id: existing?.id, action: existing ? 'updated' : 'created' })
  } catch (err) {
    console.error('[Config] Save config error:', err)
    res.status(400).json({ ok: false, error: configErrorMessage(err) })
  }
})

// Batch update config items
router.put('/system-config/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { category } = req.params
    const { items } = req.body
    if (!ADMIN_CONFIG_SCHEMA[category]) throw new Error('config_category_not_allowed')
    if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 必须是数组' })

    const changedKeys = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.value === '***REDACTED***') continue
      const normalized = normalizeConfigValue(category, item.key, item.value)
      const storedValue = protectSystemConfigValue(item.key, normalized)
      await queryRun(`
        INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), label = VALUES(label), sort_order = VALUES(sort_order), updated_at = NOW()
      `, [category, item.key, storedValue, item.label || '', item.sort_order ?? i])
      changedKeys.push(item.key)
    }
    if (category === 'crypto_wallet') resetFixedAddressCache()
    if (category === 'sms') resetSmsConfigCache()
    if (changedKeys.length) await auditConfigChange(req, 'system_config_batch_updated', category, changedKeys)
    res.json({ ok: true, count: changedKeys.length })
  } catch (err) {
    console.error('[Config] Batch update error:', err)
    res.status(400).json({ ok: false, error: configErrorMessage(err) })
  }
})

// Delete config item
router.delete('/system-config/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Get category before delete to invalidate cache
    const item = await queryOne('SELECT category, `key` FROM system_config WHERE id = ?', [req.params.id])
    if (!item || !schemaFor(item.category, item.key)) return res.status(404).json({ ok:false, error:'配置项不存在' })
    await queryRun('DELETE FROM system_config WHERE id = ?', [req.params.id])
    if (item?.category === 'crypto_wallet') resetFixedAddressCache()
    if (item?.category === 'sms') resetSmsConfigCache()
    await auditConfigChange(req, 'system_config_deleted', item.category, [item.key])
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] Delete config error:', err)
    res.json({ ok: false, error: '删除失败' })
  }
})

// Delete all config in a category
router.delete('/system-config/category/:category', authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!ADMIN_CONFIG_SCHEMA[req.params.category]) throw new Error('config_category_not_allowed')
    await queryRun('DELETE FROM system_config WHERE category = ?', [req.params.category])
    if (req.params.category === 'crypto_wallet') resetFixedAddressCache()
    if (req.params.category === 'sms') resetSmsConfigCache()
    await auditConfigChange(req, 'system_config_category_deleted', req.params.category, Object.keys(ADMIN_CONFIG_SCHEMA[req.params.category].keys))
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] Delete category error:', err)
    res.status(400).json({ ok: false, error: configErrorMessage(err) })
  }
})

// Send test email
router.post('/system-config/smtp/test', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { to } = req.body
    if (!to) return res.json({ ok: false, error: '请输入收件邮箱' })

    const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
    const cfg = systemConfigRowsToMap(rows)

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
