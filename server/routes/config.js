import { Router } from 'express'
import { createHash } from 'crypto'
import { queryOne, queryAll, queryRun, withTransaction, logAudit } from '../db.js'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { resetFixedAddressCache } from '../crypto/fixed-address.js'
import { resetSmsConfigCache } from '../sms.js'
import { validateAddress } from '../crypto/wallet.js'
import { isEncryptionAvailable } from '../ai-credential.js'
import { isSensitiveSystemConfigKey, protectSystemConfigValue, systemConfigRowsToMap } from '../system-config-secrets.js'
import { sanitizeReleaseNote } from '../html-sanitizer.js'
import { getStorageConfigSummary, invalidateStorageConfigCache, isQiniuConfigured, loadStorageConfig, readStorageConfigFromRows } from '../storage/storage-config.js'
import { testStorageConnection } from '../storage/storage-service.js'
import { getStorageOperationsSummary } from '../storage/storage-operations.js'

const router = Router()

// 仅允许这些公开类别，敏感类别（smtp、qiniu、ai_provider 等）不可通过此接口访问
const PUBLIC_CATEGORIES = new Set(['toolbox', 'market_menu', 'announcements', 'features', 'auth_toggle'])

const BOOLEAN_VALUES = new Set(['true', 'false'])
const RELEASE_NOTES_CATEGORY = 'changelog'
const RELEASE_NOTES_VERSION_KEY = 'version'
const RELEASE_NOTES_CONTENT_KEY = 'content'
const RELEASE_NOTES_MIN_VERSION = 1
const RELEASE_NOTES_MAX_VERSION = 2147483647
const RELEASE_NOTES_MAX_CONTENT_LENGTH = 50000
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
  qiniu:{ label:'七牛连接', source:'database_encrypted', apply_mode:'immediate', keys:{
    access_key:{ type:'secret' }, secret_key:{ type:'secret' }, bucket:{ type:'string', max:255 },
    // Keep the two legacy region labels accepted by the original admin
    // selector so an existing qiniu configuration remains editable after the
    // storage settings are exposed. The SDK still resolves the actual upload
    // endpoint from the bucket and credentials.
    domain:{ type:'https_origin', max:255 }, region:{ type:'enum', values:['z0','z1','z2','na0','as0','cn-east','cn-south'], default:'z0' },
    private_bucket:{ type:'boolean', default:'true', read_only:true },
  }},
  media_storage:{ label:'文件与媒体存储', source:'database', apply_mode:'immediate', keys:{
    default_provider:{ type:'enum', values:['local','qiniu'], default:'local' },
    video_provider:{ type:'enum', values:['inherit','local','qiniu'], default:'inherit' },
    attachment_provider:{ type:'enum', values:['inherit','local','qiniu'], default:'inherit' },
    image_provider:{ type:'enum', values:['inherit','local','qiniu'], default:'inherit' },
    resource_provider:{ type:'enum', values:['inherit','local','qiniu'], default:'inherit' },
    local_root:{ type:'string', read_only:true },
    qiniu_connection_test_version:{ type:'string', read_only:true },
    qiniu_connection_test_status:{ type:'string', read_only:true },
    qiniu_connection_test_stage:{ type:'string', read_only:true },
    qiniu_connection_tested_at:{ type:'string', read_only:true },
    qiniu_connection_test_error:{ type:'string', read_only:true },
    qiniu_connection_test_cleanup_pending:{ type:'boolean', read_only:true },
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
  if (meta.type === 'https_origin') {
    try {
      const url = new URL(text)
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid')
    } catch {
      throw new Error('config_https_origin_invalid')
    }
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
    config_https_origin_invalid:'请填写不带路径和参数的 HTTPS 域名',
    credential_encryption_unavailable:'凭证加密服务未就绪，敏感配置未保存',
    storage_qiniu_configuration_invalid:'七牛配置不完整或域名不是 HTTPS',
    storage_qiniu_connection_test_required:'切换到七牛前，请先测试当前七牛配置连接',
    storage_qiniu_bucket_locked:'已有七牛文件时不可切换存储空间，请先完成迁移或清理旧文件',
    storage_connection_provider_invalid:'连接测试提供商无效',
    storage_config_changed_during_test:'测试期间配置发生变化，请重新测试',
  }
  return messages[error?.message] || '配置校验失败'
}

function redactItems(items) {
  return items.map(it => isSensitiveSystemConfigKey(it.key)
    ? { ...it, value: it.value ? '***REDACTED***' : it.value }
    : it)
}

function serializeAdminConfig(rows, storageConfig = null) {
  const byKey = new Map(rows.map(row => [`${row.category}:${row.key}`, row]))
  const grouped = {}
  for (const [category, categoryMeta] of Object.entries(ADMIN_CONFIG_SCHEMA)) {
    grouped[category] = Object.entries(categoryMeta.keys).map(([key, keyMeta], index) => {
      const row = byKey.get(`${category}:${key}`) || { id:null, category, key, value:keyMeta.default ?? '', label:'', sort_order:index, created_at:null, updated_at:null }
      const redacted = redactItems([row])[0]
      if (category === 'media_storage' && key === 'local_root' && storageConfig) redacted.value = storageConfig.media.local_root
      return { ...redacted, config_meta:{ type:keyMeta.type, source:categoryMeta.source, apply_mode:categoryMeta.apply_mode,
        editable:!keyMeta.read_only, sensitive:isSensitiveSystemConfigKey(key), min:keyMeta.min, max:keyMeta.max } }
    })
  }
  return grouped
}

function assertStorageUpdateAllowed(category, prospective) {
  if (category !== 'media_storage') return
  const activatesQiniu = Object.values(prospective.effectiveProviders).includes('qiniu')
  if (!activatesQiniu) return
  if (!isQiniuConfigured(prospective.qiniu)) throw new Error('storage_qiniu_configuration_invalid')
  if (!prospective.qiniuTest.valid || prospective.qiniuTest.configVersion !== prospective.configVersion) {
    throw new Error('storage_qiniu_connection_test_required')
  }
}

async function assertQiniuBucketImmutable(runner, category, currentRows, prospective) {
  if (category !== 'qiniu') return
  const current = readStorageConfigFromRows(currentRows)
  if (current.qiniu.bucket === prospective.qiniu.bucket) return
  const [rows] = await runner("SELECT id FROM stored_files WHERE storage_provider = 'qiniu' AND status NOT IN ('deleted', 'failed') LIMIT 1 FOR UPDATE")
  if (rows?.length) throw new Error('storage_qiniu_bucket_locked')
}

function applyStorageRows(rows, category, updates) {
  const nextRows = (rows || []).map(row => ({ ...row }))
  for (const update of updates) {
    const existing = nextRows.find(row => row.category === category && row.key === update.key)
    if (existing) existing.value = update.value
    else nextRows.push({ category, key:update.key, value:update.value })
  }
  return nextRows
}

async function auditConfigChange(req, action, category, keys = []) {
  await logAudit({ userId:req.user.id, action, targetType:'system_config', detail:JSON.stringify({ category, keys }), ip:req.ip, userAgent:req.get('user-agent') })
}

function releaseNotesError(code, error) {
  const value = new Error(error)
  value.code = code
  return value
}

function parseReleaseNoteVersion(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < RELEASE_NOTES_MIN_VERSION || value > RELEASE_NOTES_MAX_VERSION) {
      throw releaseNotesError('release_notes_version_invalid', '通知序号必须是 1 到 2147483647 的整数')
    }
    return value
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw releaseNotesError('release_notes_version_invalid', '通知序号必须是 1 到 2147483647 的整数')
  }
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < RELEASE_NOTES_MIN_VERSION || normalized > RELEASE_NOTES_MAX_VERSION) {
    throw releaseNotesError('release_notes_version_invalid', '通知序号必须是 1 到 2147483647 的整数')
  }
  return normalized
}

function parseStoredReleaseNoteVersion(value) {
  try { return parseReleaseNoteVersion(String(value ?? '')) } catch { return RELEASE_NOTES_MIN_VERSION }
}

function releaseNotesRevision(version, content) {
  return createHash('sha256').update(`${version}\u0000${content}`, 'utf8').digest('hex')
}

function releaseNotesContentHash(content) {
  return createHash('sha256').update(String(content || ''), 'utf8').digest('hex')
}

function releaseNotesBodyContent(value) {
  if (value === undefined) return null
  if (typeof value !== 'string') throw releaseNotesError('release_notes_content_invalid', '更新内容必须是文本')
  if (value.length > RELEASE_NOTES_MAX_CONTENT_LENGTH) {
    throw releaseNotesError('release_notes_content_too_long', '更新内容不能超过 50000 个字符')
  }
  return sanitizeReleaseNote(value)
}

function releaseNotesPayload(version, contentResult, legacyWrite = false) {
  const content = contentResult?.content || ''
  return {
    ok: true,
    version,
    content,
    revision: releaseNotesRevision(version, content),
    sanitized: Boolean(contentResult?.removed),
    removed: Boolean(contentResult?.removed),
    removed_categories: contentResult?.removedCategories || [],
    legacy_write: legacyWrite,
  }
}

function releaseNotesRowsToState(rows) {
  const map = new Map((rows || []).map(row => [row.key, row.value]))
  const version = parseStoredReleaseNoteVersion(map.get(RELEASE_NOTES_VERSION_KEY) || String(RELEASE_NOTES_MIN_VERSION))
  const rawContent = String(map.get(RELEASE_NOTES_CONTENT_KEY) || '')
  const contentResult = sanitizeReleaseNote(rawContent)
  return { version, rawContent, contentResult }
}

async function readReleaseNotesRows() {
  return releaseNotesRowsToState(await queryAll(
    'SELECT `key`, `value` FROM system_config WHERE category = ? AND `key` IN (?, ?)',
    [RELEASE_NOTES_CATEGORY, RELEASE_NOTES_VERSION_KEY, RELEASE_NOTES_CONTENT_KEY],
  ))
}

function releaseNotesAuditDetail({ oldVersion, newVersion, oldContent, newContent, removedCategories, legacyWrite }) {
  return JSON.stringify({
    old_version:oldVersion,
    new_version:newVersion,
    old_content_hash:releaseNotesContentHash(oldContent),
    new_content_hash:releaseNotesContentHash(newContent),
    sanitized_removed_categories:removedCategories,
    legacy_write:Boolean(legacyWrite),
  })
}

function releaseNotesErrorResponse(res, error) {
  const code = String(error?.code || '')
  const status = code === 'release_notes_revision_conflict' || code === 'release_notes_version_behind' ? 409
    : code.startsWith('release_notes_') ? 400 : 500
  return res.status(status).json({ ok:false, code:code || 'release_notes_update_failed', error:error?.message || '更新失败' })
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
    const state = await readReleaseNotesRows()
    res.json(releaseNotesPayload(state.version, state.contentResult))
  } catch (err) {
    console.error('[Config] Changelog error:', err)
    const contentResult = sanitizeReleaseNote('')
    res.json(releaseNotesPayload(RELEASE_NOTES_MIN_VERSION, contentResult))
  }
})

// Admin: get changelog
router.get('/admin/release-notes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const state = await readReleaseNotesRows()
    res.json(releaseNotesPayload(state.version, state.contentResult))
  } catch (err) {
    console.error('[Config] Get changelog error:', err)
    res.status(500).json({ ok:false, code:'release_notes_read_failed', error:'读取失败' })
  }
})

// Admin: read-only server-side release note preview
router.post('/admin/release-notes/preview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const contentResult = releaseNotesBodyContent(req.body?.content)
    if (!contentResult) throw releaseNotesError('release_notes_content_invalid', '请提供更新内容')
    res.json({
      ok:true,
      content:contentResult.content,
      sanitized:contentResult.sanitized,
      removed:contentResult.removed,
      removed_categories:contentResult.removedCategories,
    })
  } catch (error) {
    releaseNotesErrorResponse(res, error)
  }
})

// Admin: update changelog
router.post('/admin/release-notes', authMiddleware, adminOnly, async (req, res) => {
  const { version, content, expected_revision:expectedRevision } = req.body || {}
  try {
    if (version === undefined || version === null) throw releaseNotesError('release_notes_version_required', '通知序号必填')
    const nextVersion = parseReleaseNoteVersion(version)
    const nextContentResult = releaseNotesBodyContent(content)
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedRevision))) {
      throw releaseNotesError('release_notes_revision_invalid', '发布说明版本已失效，请刷新后重试')
    }
    const result = await withTransaction(async runner => {
      // Insert missing rows idempotently before locking both keys in a fixed
      // order. The unique (category, key) index makes this safe across old
      // installations that predate the changelog seed.
      await runner('INSERT INTO system_config (category, `key`, `value`, label) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `key` = VALUES(`key`)', [RELEASE_NOTES_CATEGORY, RELEASE_NOTES_VERSION_KEY, String(RELEASE_NOTES_MIN_VERSION), '当前通知序号'])
      await runner('INSERT INTO system_config (category, `key`, `value`, label) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `key` = VALUES(`key`)', [RELEASE_NOTES_CATEGORY, RELEASE_NOTES_CONTENT_KEY, '', '更新日志内容（HTML）'])
      const [lockedRows] = await runner(`SELECT \`key\`, \`value\` FROM system_config WHERE category = ? AND \`key\` IN (?, ?) ORDER BY CASE \`key\` WHEN ? THEN 1 WHEN ? THEN 2 END FOR UPDATE`, [RELEASE_NOTES_CATEGORY, RELEASE_NOTES_VERSION_KEY, RELEASE_NOTES_CONTENT_KEY, RELEASE_NOTES_VERSION_KEY, RELEASE_NOTES_CONTENT_KEY])
      const current = releaseNotesRowsToState(lockedRows)
      const currentRevision = releaseNotesRevision(current.version, current.contentResult.content)
      if (expectedRevision !== undefined && expectedRevision.toLowerCase() !== currentRevision) {
        throw releaseNotesError('release_notes_revision_conflict', '发布说明已被其他管理员修改，请刷新后重试')
      }
      if (nextVersion < current.version) {
        throw releaseNotesError('release_notes_version_behind', '通知序号不能小于当前序号')
      }
      const nextState = nextContentResult || current.contentResult
      const nextStoredContent = nextContentResult ? nextState.content : current.rawContent
      if (nextState.content.length > RELEASE_NOTES_MAX_CONTENT_LENGTH) {
        throw releaseNotesError('release_notes_content_too_long', '更新内容不能超过 50000 个字符')
      }
      const removedCategories = [...new Set([
        ...current.contentResult.removedCategories,
        ...(nextContentResult?.removedCategories || []),
      ])].sort()
      const legacyWrite = expectedRevision === undefined
      await runner('UPDATE system_config SET `value` = ?, updated_at = NOW() WHERE category = ? AND `key` = ?', [String(nextVersion), RELEASE_NOTES_CATEGORY, RELEASE_NOTES_VERSION_KEY])
      if (nextContentResult) await runner('UPDATE system_config SET `value` = ?, updated_at = NOW() WHERE category = ? AND `key` = ?', [nextStoredContent, RELEASE_NOTES_CATEGORY, RELEASE_NOTES_CONTENT_KEY])
      const detail = releaseNotesAuditDetail({ oldVersion:current.version, newVersion:nextVersion, oldContent:current.rawContent, newContent:nextStoredContent, removedCategories, legacyWrite })
      const [users] = await runner('SELECT email, nickname FROM users WHERE id = ?', [req.user.id])
      const actor = users?.[0] || {}
      await runner(`INSERT INTO audit_logs (user_id, user_email, user_nickname, action, target_type, target_id, detail, ip, user_agent)
        VALUES (?, ?, ?, 'release_notes_updated', 'system_config', NULL, ?, ?, ?)`, [req.user.id, actor.email || '', actor.nickname || '', detail, req.ip || '', req.get('user-agent') || ''])
      return { version:nextVersion, contentResult:nextState, legacyWrite }
    })
    res.json(releaseNotesPayload(result.version, result.contentResult, result.legacyWrite))
  } catch (err) {
    console.error('[Config] Update changelog error:', err)
    releaseNotesErrorResponse(res, err)
  }
})

// Get all config (grouped by category)
router.get('/system-config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM system_config ORDER BY category, sort_order, id')
    const storageConfig = readStorageConfigFromRows(rows)
    const storage = getStorageConfigSummary(storageConfig)
    storage.operations = await getStorageOperationsSummary()
    res.json({ ok: true, config:serializeAdminConfig(rows, storageConfig), storage, security:{ credential_encryption_available:isEncryptionAvailable() } })
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
    const storageRows = ['media_storage', 'qiniu'].includes(req.params.category)
      ? await queryAll('SELECT category, `key`, `value` FROM system_config WHERE category IN (?, ?) ORDER BY category, sort_order, id', ['media_storage', 'qiniu'])
      : rows
    const storageConfig = readStorageConfigFromRows(storageRows)
    res.json({ ok: true, items: serializeAdminConfig(rows, storageConfig)[req.params.category] || [], storage:getStorageConfigSummary(storageConfig) })
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

    let existing = null
    if (category === 'media_storage' || category === 'qiniu') {
      existing = await withTransaction(async runner => {
        const [rows] = await runner('SELECT category, `key`, `value` FROM system_config WHERE category IN (?, ?) ORDER BY category, sort_order, id FOR UPDATE', ['media_storage', 'qiniu'])
        const prospective = readStorageConfigFromRows(applyStorageRows(rows, category, [{ key, value:normalized }]))
        await assertQiniuBucketImmutable(runner, category, rows, prospective)
        assertStorageUpdateAllowed(category, prospective)
        const [existingRows] = await runner('SELECT id FROM system_config WHERE category = ? AND `key` = ? FOR UPDATE', [category, key])
        if (existingRows?.[0]) {
          await runner('UPDATE system_config SET `value` = ?, label = ?, sort_order = ?, updated_at = NOW() WHERE id = ?',
            [storedValue, label || '', sort_order || 0, existingRows[0].id])
          return existingRows[0]
        }
        await runner('INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)',
          [category, key, storedValue, label || '', sort_order || 0])
        return null
      })
    } else {
      existing = await queryOne('SELECT id FROM system_config WHERE category = ? AND `key` = ?', [category, key])
      if (existing) {
        await queryRun('UPDATE system_config SET `value` = ?, label = ?, sort_order = ?, updated_at = NOW() WHERE id = ?',
          [storedValue, label || '', sort_order || 0, existing.id])
      } else {
        await queryRun('INSERT INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)',
          [category, key, storedValue, label || '', sort_order || 0])
      }
    }
    if (category === 'crypto_wallet') resetFixedAddressCache()
    if (category === 'sms') resetSmsConfigCache()
    if (category === 'media_storage' || category === 'qiniu') invalidateStorageConfigCache()
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
    const normalizedItems = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.value === '***REDACTED***') continue
      const normalized = normalizeConfigValue(category, item.key, item.value)
      normalizedItems.push({ item, normalized, storedValue:protectSystemConfigValue(item.key, normalized), index:i })
    }
    const writeItems = async runner => {
      let currentRows = []
      if (category === 'media_storage' || category === 'qiniu') {
        const result = await runner('SELECT category, `key`, `value` FROM system_config WHERE category IN (?, ?) ORDER BY category, sort_order, id FOR UPDATE', ['media_storage', 'qiniu'])
        currentRows = result?.[0] || []
        const prospective = readStorageConfigFromRows(applyStorageRows(currentRows, category, normalizedItems.map(entry => ({ key:entry.item.key, value:entry.normalized }))))
        await assertQiniuBucketImmutable(runner, category, currentRows, prospective)
        assertStorageUpdateAllowed(category, prospective)
      }
      for (const entry of normalizedItems) {
        await runner(`
          INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), label = VALUES(label), sort_order = VALUES(sort_order), updated_at = NOW()
        `, [category, entry.item.key, entry.storedValue, entry.item.label || '', entry.item.sort_order ?? entry.index])
        changedKeys.push(entry.item.key)
      }
    }
    if (category === 'media_storage' || category === 'qiniu') await withTransaction(writeItems)
    else await writeItems(async (...args) => {
      const result = await queryRun(...args)
      return [result]
    })
    if (category === 'crypto_wallet') resetFixedAddressCache()
    if (category === 'sms') resetSmsConfigCache()
    if (category === 'media_storage' || category === 'qiniu') invalidateStorageConfigCache()
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
    if (item?.category === 'media_storage' || item?.category === 'qiniu') invalidateStorageConfigCache()
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
    if (req.params.category === 'media_storage' || req.params.category === 'qiniu') invalidateStorageConfigCache()
    await auditConfigChange(req, 'system_config_category_deleted', req.params.category, Object.keys(ADMIN_CONFIG_SCHEMA[req.params.category].keys))
    res.json({ ok: true })
  } catch (err) {
    console.error('[Config] Delete category error:', err)
    res.status(400).json({ ok: false, error: configErrorMessage(err) })
  }
})

const STORAGE_TEST_ERROR_CODES = new Set([
  'storage_qiniu_configuration_invalid', 'storage_qiniu_connection_test_failed', 'storage_qiniu_upload_failed',
  'storage_qiniu_stat_failed', 'storage_qiniu_download_failed', 'storage_qiniu_delete_failed', 'storage_qiniu_cleanup_failed',
  'storage_qiniu_object_key_mismatch', 'storage_qiniu_object_missing', 'storage_qiniu_object_size_mismatch', 'storage_qiniu_object_mime_mismatch', 'storage_config_changed_during_test',
])

function storageTestError(error) {
  const code = STORAGE_TEST_ERROR_CODES.has(error?.code) ? error.code : 'storage_qiniu_connection_test_failed'
  const messages = {
    storage_qiniu_configuration_invalid:'七牛配置不完整或域名不是 HTTPS，请检查连接配置。',
    storage_qiniu_connection_test_failed:'七牛连接测试失败，请检查凭证、空间和网络后重试。',
    storage_qiniu_upload_failed:'测试对象上传失败，请检查空间写入权限。',
    storage_qiniu_stat_failed:'测试对象读取失败，请检查空间访问权限。',
    storage_qiniu_download_failed:'测试对象 HTTPS 读取失败，请检查私有域名、回源和访问权限。',
    storage_qiniu_delete_failed:'测试对象删除失败，请检查空间删除权限。',
    storage_qiniu_cleanup_failed:'测试对象清理失败，系统已标记测试失败，请稍后重试。',
    storage_qiniu_object_key_mismatch:'云端返回的测试对象与本次会话不一致。',
    storage_qiniu_object_missing:'云端未找到上传对象，不能确认直传结果。',
    storage_qiniu_object_size_mismatch:'云端测试对象大小校验失败。',
    storage_qiniu_object_mime_mismatch:'云端测试对象 MIME 与上传会话不一致。',
    storage_config_changed_during_test:'测试期间配置发生变化，请保存后重新测试。',
  }
  return { code, message:messages[code] }
}

function sqlDateTime(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

async function persistStorageTestResult({ configVersion, status, stage, testedAt, errorCode = '', cleanupPending = false }) {
  return withTransaction(async runner => {
    const [rows] = await runner('SELECT category, `key`, `value` FROM system_config WHERE category IN (?, ?) ORDER BY category, sort_order, id FOR UPDATE', ['media_storage', 'qiniu'])
    const current = readStorageConfigFromRows(rows || [])
    if (current.configVersion !== configVersion) throw new Error('storage_config_changed_during_test')
    const values = [
      ['qiniu_connection_test_version', configVersion],
      ['qiniu_connection_test_status', status],
      ['qiniu_connection_test_stage', stage || ''],
      ['qiniu_connection_tested_at', testedAt || sqlDateTime()],
      ['qiniu_connection_test_error', errorCode || ''],
      ['qiniu_connection_test_cleanup_pending', cleanupPending ? 'true' : 'false'],
    ]
    for (const [key, value] of values) {
      await runner(`
        INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = NOW()
      `, ['media_storage', key, String(value), `七牛连接测试 ${key}`, 6])
    }
    return { configVersion, status, stage:stage || '', testedAt:testedAt || sqlDateTime(), error:errorCode || '', cleanupPending:Boolean(cleanupPending) }
  })
}

// Admin: test the current Qiniu configuration. The temporary object is
// created and deleted by the provider; credentials, tokens and signed URLs
// never enter the response or the audit detail.
router.post('/system-config/media_storage/test', authMiddleware, adminOnly, async (req, res) => {
  let config
  try {
    config = await loadStorageConfig({ force:true })
    if (!isQiniuConfigured(config.qiniu)) throw Object.assign(new Error('storage_qiniu_configuration_invalid'), { code:'storage_qiniu_configuration_invalid', stage:'credentials' })
    const result = await testStorageConnection(config)
    const testedAt = sqlDateTime()
    const stored = await persistStorageTestResult({ configVersion:config.configVersion, status:'succeeded', stage:result.stage || 'completed', testedAt, cleanupPending:false })
    invalidateStorageConfigCache()
    await auditConfigChange(req, 'system_config_storage_tested', 'media_storage', ['qiniu_connection_test'])
    return res.json({ ok:true, provider:'qiniu', config_version:config.configVersion, test:{ status:stored.status, stage:stored.stage, tested_at:stored.testedAt, cleanup_pending:stored.cleanupPending } })
  } catch (error) {
    const safe = storageTestError(error)
    try {
      if (config?.configVersion) {
        const stored = await persistStorageTestResult({ configVersion:config.configVersion, status:'failed', stage:error?.stage || 'credentials', testedAt:sqlDateTime(), errorCode:safe.code, cleanupPending:safe.code === 'storage_qiniu_cleanup_failed' || Boolean(error?.cleanupFailed) })
        invalidateStorageConfigCache()
        await auditConfigChange(req, 'system_config_storage_tested', 'media_storage', ['qiniu_connection_test'])
        return res.status(safe.code === 'storage_config_changed_during_test' ? 409 : 400).json({ ok:false, provider:'qiniu', config_version:config.configVersion, test:{ status:stored.status, stage:stored.stage, tested_at:stored.testedAt, cleanup_pending:stored.cleanupPending }, code:safe.code, error:safe.message })
      }
    } catch (persistError) {
      if (persistError?.message === 'storage_config_changed_during_test') {
        return res.status(409).json({ ok:false, code:'storage_config_changed_during_test', error:'测试期间配置发生变化，请保存后重新测试。' })
      }
    }
    return res.status(400).json({ ok:false, code:safe.code, error:safe.message })
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
