import crypto from 'node:crypto'
import { JWT_SECRET } from './config.js'
import { queryOne, queryAll, queryRun, withTransaction, logAudit } from './db.js'
import { sendUserNotificationEmail } from './system-email.js'
import { sendNotificationCreatedToUser } from './bridge-ws.js'

const PLAN_VALUES = new Set(['free', 'plus', 'pro', 'expired'])
const SCOPE_VALUES = new Set(['user', 'plans', 'all'])
const PRIORITY_VALUES = new Set(['normal', 'important'])
const MAX_EMAIL_ATTEMPTS = 5
const WORKER_INTERVAL_MS = 2_000
const PREVIEW_TTL_MS = 10 * 60 * 1000
const PREVIEW_SECRET = () => String(JWT_SECRET)

export const NOTIFICATION_ERRORS = Object.freeze({
  invalid_scope: '通知范围无效',
  invalid_user: '指定用户无效',
  invalid_plans: '请选择有效的会员范围',
  empty_recipients: '当前范围没有可发送的用户',
  invalid_title: '标题必须是 1 到 100 个字符',
  invalid_message: '正文必须是 1 到 1000 个字符',
  invalid_priority: '通知级别无效',
  invalid_link: '链接仅允许站内账户或 AI 页面',
  missing_idempotency_key: '请提供幂等键',
  invalid_preview: '预览已过期或内容已变化，请重新预览',
  recipient_count_changed: '通知范围已变化，请重新确认',
  all_confirmation_required: '发送给全部用户前请输入确认词“发送给全部用户”',
  campaign_not_found: '通知活动不存在',
  campaign_not_retryable: '当前活动没有可重试的邮件',
})

export class NotificationError extends Error {
  constructor(code, message = NOTIFICATION_ERRORS[code] || '通知操作失败', status = 400, extra = {}) {
    super(message)
    this.name = 'NotificationError'
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

function textLength(value) {
  return Array.from(String(value || '')).length
}

function normalizeText(value, max, code) {
  if (typeof value !== 'string') throw new NotificationError(code)
  const normalized = value.normalize('NFC').trim()
  if (!normalized || textLength(normalized) > max) throw new NotificationError(code)
  return normalized
}

function asPositiveInt(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function normalizeNotificationScope(body = {}) {
  const scope = String(body.recipientScope ?? body.recipient_scope ?? '').trim().toLowerCase()
  if (!SCOPE_VALUES.has(scope)) throw new NotificationError('invalid_scope')
  const rawFilter = body.recipientFilter ?? body.recipient_filter ?? {}
  if (!rawFilter || typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    throw new NotificationError(scope === 'user' ? 'invalid_user' : 'invalid_plans')
  }
  if (scope === 'user') {
    const userId = asPositiveInt(rawFilter.userId ?? rawFilter.user_id ?? body.userId ?? body.user_id)
    if (!userId) throw new NotificationError('invalid_user')
    return { recipientScope:scope, recipientFilter:{ userId } }
  }
  if (scope === 'plans') {
    const values = rawFilter.plans ?? rawFilter.plan ?? body.plans
    const normalizedValues = (Array.isArray(values) ? values : [values])
      .map(value => String(value || '').trim().toLowerCase())
    if (!normalizedValues.length || normalizedValues.some(value => !PLAN_VALUES.has(value))) throw new NotificationError('invalid_plans')
    const plans = [...new Set(normalizedValues)]
    return { recipientScope:scope, recipientFilter:{ plans:plans.sort() } }
  }
  return { recipientScope:'all', recipientFilter:{} }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function recipientCriteriaHash(scope, filter) {
  return crypto.createHash('sha256').update(stableJson({ scope, filter }), 'utf8').digest('hex')
}

export function validateInternalNotificationLink(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  if (typeof value !== 'string' || value.length > 500) throw new NotificationError('invalid_link')
  const raw = value.normalize('NFC').trim()
  // Only relative paths are accepted.  The same-origin parser below is useful
  // for normalizing the query, but must not turn an absolute URL whose host
  // happens to match the parser sentinel into an accepted link.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) {
    throw new NotificationError('invalid_link')
  }
  // WHATWG URL parsing normalizes dot segments before exposing `pathname`.
  // Decode and validate the raw path first so an encoded traversal such as
  // `/%2e%2e/account/` cannot be normalized into an apparently safe path.
  const queryStart = raw.indexOf('?')
  const rawPath = queryStart === -1 ? raw : raw.slice(0, queryStart)
  let decodedRawPath
  try { decodedRawPath = decodeURIComponent(rawPath) } catch { throw new NotificationError('invalid_link') }
  if (!decodedRawPath.startsWith('/') || decodedRawPath.startsWith('//')
    || decodedRawPath.includes('\\') || decodedRawPath.includes('..')
    || /(?:%2e|%2f|%5c)/i.test(decodedRawPath)
    || /[\u0000-\u001f]/.test(decodedRawPath)) {
    throw new NotificationError('invalid_link')
  }
  let parsed
  try { parsed = new URL(raw, 'https://aurum.invalid') } catch { throw new NotificationError('invalid_link') }
  if (parsed.origin !== 'https://aurum.invalid' || parsed.protocol !== 'https:'
    || parsed.username || parsed.password || parsed.hash) throw new NotificationError('invalid_link')
  let pathname
  try { pathname = decodeURIComponent(parsed.pathname) } catch { throw new NotificationError('invalid_link') }
  if (pathname !== '/' && !/^\/(?:account|ai)(?:\/|$)/.test(pathname)) throw new NotificationError('invalid_link')
  if (pathname.includes('..') || pathname.startsWith('/admin') || pathname.startsWith('/api')
    || pathname.startsWith('/uploads') || pathname.startsWith('/download')) throw new NotificationError('invalid_link')
  const allowed = pathname === '/'
    ? new Set()
    : pathname.startsWith('/account')
      ? new Set(['embed', 'tab', 'section', 'notification', 'id', 'surface', 'page'])
      : new Set(['symbol', 'timeframe', 'tab', 'section', 'notification', 'id'])
  for (const key of parsed.searchParams.keys()) {
    const normalized = String(key || '').trim().toLowerCase()
    if (!allowed.has(normalized) || /(?:token|password|secret|credential|auth|redirect|return|code|key)/i.test(normalized)) {
      throw new NotificationError('invalid_link')
    }
    for (const valueItem of parsed.searchParams.getAll(key)) {
      if (valueItem.length > 200 || /(?:javascript:|data:|https?:|\/\/|token|password|secret|credential)/i.test(valueItem)) {
        throw new NotificationError('invalid_link')
      }
    }
  }
  return `${pathname}${parsed.search}`
}

export function normalizeNotificationContent(body = {}) {
  const title = normalizeText(body.title, 100, 'invalid_title')
  const message = normalizeText(body.message ?? body.body, 1000, 'invalid_message')
  const priority = String(body.priority || 'normal').trim().toLowerCase()
  if (!PRIORITY_VALUES.has(priority)) throw new NotificationError('invalid_priority')
  return {
    title,
    message,
    priority,
    requiresAck:priority === 'important',
    link:validateInternalNotificationLink(body.link),
    inAppEnabled:true,
    emailEnabled:asBoolean(body.emailEnabled ?? body.email_enabled, false),
  }
}

function baseRecipientWhere(scope, filter, alias = 'u') {
  const conditions = [
    `COALESCE(${alias}.deletion_status, 'active') = 'active'`,
    `${alias}.deleted_at IS NULL`,
    `COALESCE(${alias}.role, 'user') <> 'admin'`,
    `COALESCE(${alias}.plan_source, '') <> 'observer_source'`,
  ]
  const params = []
  if (scope === 'user') {
    conditions.push(`${alias}.id = ?`)
    params.push(filter.userId)
  } else if (scope === 'plans') {
    const planConditions = []
    for (const plan of filter.plans) {
      if (plan === 'free') planConditions.push(`${alias}.plan = 'free'`)
      if (plan === 'plus' || plan === 'pro') {
        planConditions.push(`(${alias}.plan = ? AND (${alias}.plan_expires_at IS NULL OR ${alias}.plan_expires_at >= NOW()))`)
        params.push(plan)
      }
      if (plan === 'expired') planConditions.push(`(${alias}.plan IN ('plus', 'pro') AND ${alias}.plan_expires_at IS NOT NULL AND ${alias}.plan_expires_at < NOW())`)
    }
    conditions.push(`(${planConditions.join(' OR ')})`)
  }
  return { where:conditions.join(' AND '), params }
}

export function buildNotificationRecipientWhere(scope, filter, alias = 'u') {
  return baseRecipientWhere(scope, filter, alias)
}

function previewTokenPayload(actorId, criteria, content, count) {
  return {
    actorId:Number(actorId),
    criteriaHash:recipientCriteriaHash(criteria.recipientScope, criteria.recipientFilter),
    contentHash:crypto.createHash('sha256').update(stableJson(content), 'utf8').digest('hex'),
    count:Number(count),
    expiresAt:Date.now() + PREVIEW_TTL_MS,
    nonce:crypto.randomBytes(8).toString('hex'),
  }
}

function signPreviewPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = crypto.createHmac('sha256', PREVIEW_SECRET()).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function readPreviewPayload(token) {
  if (typeof token !== 'string') return null
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const expected = crypto.createHmac('sha256', PREVIEW_SECRET()).update(encoded).digest('base64url')
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    return payload && Number(payload.expiresAt) > Date.now() ? payload : null
  } catch { return null }
}

export function verifyNotificationPreviewToken(token, actorId, criteria, content, count) {
  const payload = readPreviewPayload(token)
  if (!payload || Number(payload.actorId) !== Number(actorId)
    || payload.criteriaHash !== recipientCriteriaHash(criteria.recipientScope, criteria.recipientFilter)
    || payload.contentHash !== crypto.createHash('sha256').update(stableJson(content), 'utf8').digest('hex')
    || Number(payload.count) !== Number(count)) return false
  return true
}

function membershipExpiredValue(row) {
  const plan = String(row?.plan || '').toLowerCase()
  if (!['plus', 'pro'].includes(plan)) return false
  if (row?.membership_expired !== undefined) return Boolean(Number(row.membership_expired))
  if (!row?.plan_expires_at) return false
  const expiry = new Date(String(row.plan_expires_at).replace(' ', 'T') + '+08:00').getTime()
  return Number.isFinite(expiry) && expiry < Date.now()
}

function mapSample(row) {
  return {
    id:Number(row.id),
    uid:row.uid || '',
    nickname:row.nickname || '',
    email:row.email || '',
    plan:row.plan || 'free',
    membershipExpired:membershipExpiredValue(row),
  }
}

export async function resolveNotificationRecipients(criteria, { sampleLimit = 5 } = {}) {
  const { where, params } = baseRecipientWhere(criteria.recipientScope, criteria.recipientFilter)
  const countRow = await queryOne(`SELECT COUNT(*) AS recipient_count,
      COALESCE(SUM(CASE WHEN u.email IS NOT NULL AND TRIM(u.email) <> '' AND u.email_verified = 1 THEN 1 ELSE 0 END), 0) AS email_reachable_count
    FROM users u WHERE ${where}`, params)
  const recipientCount = Number(countRow?.recipient_count || 0)
  const sample = await queryAll(`SELECT u.id, u.uid, u.nickname, u.email, u.plan, u.plan_expires_at,
      (u.plan IN ('plus', 'pro') AND u.plan_expires_at IS NOT NULL AND u.plan_expires_at < NOW()) AS membership_expired
    FROM users u WHERE ${where} ORDER BY u.id ASC LIMIT ?`, [...params, Math.min(Math.max(Number(sampleLimit) || 5, 1), 10)])
  const totalRow = await queryOne('SELECT COUNT(*) AS total_count FROM users')
  const emailReachableCount = Number(countRow?.email_reachable_count || 0)
  return {
    recipientCount,
    inAppCount:recipientCount,
    emailReachableCount,
    emailSkippedCount:Math.max(0, recipientCount - emailReachableCount),
    excludedCount:Math.max(0, Number(totalRow?.total_count || recipientCount) - recipientCount),
    sample:sample.map(mapSample),
  }
}

function normalizeCriteriaAndContent(body) {
  const criteria = normalizeNotificationScope(body)
  const content = normalizeNotificationContent(body)
  return { criteria, content }
}

export async function previewNotifications(actorId, body = {}) {
  const { criteria, content } = normalizeCriteriaAndContent(body)
  const summary = await resolveNotificationRecipients(criteria)
  const token = signPreviewPayload(previewTokenPayload(actorId, criteria, content, summary.recipientCount))
  return { ...summary, token }
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

export function campaignToApi(row) {
  return {
    id:Number(row.id),
    title:row.title || '',
    message:row.message || '',
    priority:row.priority || 'normal',
    requiresAck:Boolean(Number(row.requires_ack)),
    link:row.link || null,
    recipientScope:row.recipient_scope,
    recipientFilter:parseJson(row.recipient_filter_json, {}),
    previewRecipientCount:Number(row.preview_recipient_count || 0),
    recipientCount:Number(row.recipient_count || 0),
    inAppEnabled:Boolean(Number(row.in_app_enabled ?? 1)),
    emailEnabled:Boolean(Number(row.email_enabled)),
    inAppSentCount:Number(row.in_app_sent_count || 0),
    emailSentCount:Number(row.email_sent_count || 0),
    emailFailedCount:Number(row.email_failed_count || 0),
    emailSkippedCount:Number(row.email_skipped_count || 0),
    status:row.status || 'queued',
    createdBy:Number(row.created_by || 0),
    createdAt:row.created_at || null,
    startedAt:row.started_at || null,
    completedAt:row.completed_at || null,
    cancelledAt:row.cancelled_at || null,
  }
}

async function findExistingCampaign(actorId, key) {
  return queryOne('SELECT * FROM notification_campaigns WHERE created_by = ? AND idempotency_key = ?', [actorId, key])
}

function requireIdempotency(key) {
  const normalized = String(key || '').trim()
  if (!normalized || normalized.length > 191) throw new NotificationError('missing_idempotency_key')
  return normalized
}

async function auditNotification(req, action, campaignId, detail = {}) {
  await logAudit({
    userId:req?.user?.id,
    action,
    targetType:'notification_campaign',
    targetId:campaignId,
    detail:JSON.stringify(detail),
    ip:req?.ip,
    userAgent:req?.get?.('user-agent'),
  })
}

export async function createNotificationCampaign(actorId, body = {}, { idempotencyKey, request = null } = {}) {
  const key = requireIdempotency(idempotencyKey)
  const existing = await findExistingCampaign(actorId, key)
  if (existing) return { campaign:campaignToApi(existing), replayed:true }
  const { criteria, content } = normalizeCriteriaAndContent(body)
  if (criteria.recipientScope === 'all' && String(body.confirmAllText ?? body.confirm_all_text ?? '') !== '发送给全部用户') {
    throw new NotificationError('all_confirmation_required')
  }
  const summary = await resolveNotificationRecipients(criteria)
  if (!summary.recipientCount) throw new NotificationError('empty_recipients')
  const confirmed = Number(body.confirmedRecipientCount ?? body.confirmed_recipient_count)
  if (!verifyNotificationPreviewToken(body.previewToken ?? body.preview_token, actorId, criteria, content, Number(body.confirmedRecipientCount ?? body.confirmed_recipient_count))) {
    throw new NotificationError('invalid_preview')
  }
  if (!Number.isSafeInteger(confirmed) || confirmed !== summary.recipientCount) {
    const preview = {
      ...summary,
      token:signPreviewPayload(previewTokenPayload(actorId, criteria, content, summary.recipientCount)),
    }
    throw new NotificationError('recipient_count_changed', NOTIFICATION_ERRORS.recipient_count_changed, 409, { preview })
  }
  let result
  try {
    result = await queryRun(`INSERT INTO notification_campaigns
      (title, message, priority, requires_ack, link, recipient_scope, recipient_filter_json,
       preview_recipient_count, recipient_count, in_app_enabled, email_enabled, status, created_by, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 'queued', ?, ?)`, [
      content.title, content.message, content.priority, content.requiresAck ? 1 : 0, content.link,
      criteria.recipientScope, JSON.stringify(criteria.recipientFilter), summary.recipientCount,
      content.emailEnabled ? 1 : 0, actorId, key,
    ])
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      const duplicate = await findExistingCampaign(actorId, key)
      if (duplicate) return { campaign:campaignToApi(duplicate), replayed:true }
    }
    throw error
  }
  const campaign = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [result.insertId])
  if (!campaign) throw new NotificationError('campaign_not_found', '通知活动创建失败', 500)
  await auditNotification(request, 'notification_campaign_created', campaign.id, {
    recipient_scope:criteria.recipientScope,
    recipient_count:summary.recipientCount,
    priority:content.priority,
    channels:{ in_app:true, email:content.emailEnabled },
  })
  kickNotificationWorker()
  return { campaign:campaignToApi(campaign), replayed:false }
}

function campaignId(value) {
  const id = asPositiveInt(value)
  if (!id) throw new NotificationError('campaign_not_found')
  return id
}

async function storeOperationIdempotency(actorId, operation, key, id, response) {
  try {
    await queryRun(`INSERT INTO notification_idempotency_keys
      (actor_user_id, operation, idempotency_key, campaign_id, response_json)
      VALUES (?, ?, ?, ?, ?)`, [actorId, operation, key, id, JSON.stringify(response)])
    return false
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error
    const previous = await queryOne(`SELECT response_json FROM notification_idempotency_keys
      WHERE actor_user_id = ? AND operation = ? AND idempotency_key = ?`, [actorId, operation, key])
    if (!previous) throw error
    return parseJson(previous.response_json, response)
  }
}

export async function cancelNotificationCampaign(actorId, id, { idempotencyKey, request = null } = {}) {
  const key = requireIdempotency(idempotencyKey)
  const campaignIdValue = campaignId(id)
  const existingOp = await queryOne(`SELECT response_json FROM notification_idempotency_keys
    WHERE actor_user_id = ? AND operation = 'cancel' AND idempotency_key = ?`, [actorId, key])
  if (existingOp) return parseJson(existingOp.response_json, { campaign:null })
  const campaign = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignIdValue])
  if (!campaign) throw new NotificationError('campaign_not_found', undefined, 404)
  if (!['completed', 'partial_failed', 'cancelled'].includes(campaign.status)) {
    await queryRun(`UPDATE notification_campaigns SET status = 'cancelling' WHERE id = ?
      AND status NOT IN ('completed', 'partial_failed', 'cancelled')`, [campaignIdValue])
    await queryRun(`UPDATE notification_deliveries SET status = 'cancelled', updated_at = NOW()
      WHERE campaign_id = ? AND status IN ('pending', 'failed')`, [campaignIdValue])
    await finalizeCampaign(campaignIdValue)
  }
  const updated = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignIdValue])
  const response = { campaign:campaignToApi(updated) }
  const stored = await storeOperationIdempotency(actorId, 'cancel', key, campaignIdValue, response)
  if (stored) return stored
  await auditNotification(request, 'notification_campaign_cancelled', campaignIdValue, { status:updated?.status || 'cancelled' })
  return response
}

export async function retryFailedNotificationEmails(actorId, id, { idempotencyKey, request = null } = {}) {
  const key = requireIdempotency(idempotencyKey)
  const campaignIdValue = campaignId(id)
  const existingOp = await queryOne(`SELECT response_json FROM notification_idempotency_keys
    WHERE actor_user_id = ? AND operation = 'retry_email' AND idempotency_key = ?`, [actorId, key])
  if (existingOp) return parseJson(existingOp.response_json, { campaign:null })
  const campaign = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignIdValue])
  if (!campaign) throw new NotificationError('campaign_not_found', undefined, 404)
  if (campaign.status === 'cancelled') throw new NotificationError('campaign_not_retryable')
  const failed = await queryOne(`SELECT
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count
    FROM notification_deliveries WHERE campaign_id = ? AND channel = 'email' AND status IN ('failed', 'unknown')`, [campaignIdValue])
  const failedCount = Number(failed?.failed_count || 0)
  const unknownCount = Number(failed?.unknown_count || 0)
  if (!failedCount && !unknownCount) throw new NotificationError('campaign_not_retryable')
  await queryRun(`UPDATE notification_deliveries SET status = 'pending', next_attempt_at = NOW(), last_error = NULL
    WHERE campaign_id = ? AND channel = 'email' AND status IN ('failed', 'unknown')`, [campaignIdValue])
  await queryRun(`UPDATE notification_campaigns SET status = 'sending', completed_at = NULL WHERE id = ?`, [campaignIdValue])
  const updated = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignIdValue])
  const response = {
    campaign:campaignToApi(updated),
    possibleDuplicate:unknownCount > 0,
    warning:unknownCount > 0 ? '部分邮件状态未知，人工重试可能造成重复邮件' : null,
  }
  const stored = await storeOperationIdempotency(actorId, 'retry_email', key, campaignIdValue, response)
  if (stored) return stored
  await auditNotification(request, 'notification_email_retry_requested', campaignIdValue, { failed_count:failedCount, unknown_count:unknownCount })
  kickNotificationWorker()
  return response
}

async function materializeCampaign(campaignIdValue) {
  return withTransaction(async runner => {
    const [rows] = await runner('SELECT * FROM notification_campaigns WHERE id = ? FOR UPDATE', [campaignIdValue])
    const campaign = rows?.[0]
    if (!campaign) return { status:'missing' }
    if (['completed', 'partial_failed', 'cancelled', 'cancelling', 'needs_review'].includes(campaign.status)) return { status:campaign.status }
    await runner(`UPDATE notification_campaigns SET status = 'materializing', started_at = COALESCE(started_at, NOW()) WHERE id = ?`, [campaignIdValue])
    const criteria = {
      recipientScope:campaign.recipient_scope,
      recipientFilter:parseJson(campaign.recipient_filter_json, {}),
    }
    const { where, params } = baseRecipientWhere(criteria.recipientScope, criteria.recipientFilter)
    if (Number(campaign.in_app_enabled) === 1) {
      await runner(`INSERT IGNORE INTO notification_deliveries (campaign_id, user_id, channel, status, next_attempt_at)
        SELECT ?, u.id, 'in_app', 'pending', NOW() FROM users u WHERE ${where}`, [campaignIdValue, ...params])
    }
    const [recipientRows] = await runner(`SELECT COUNT(*) AS c FROM notification_deliveries
      WHERE campaign_id = ? AND channel = 'in_app'`, [campaignIdValue])
    const recipientCount = Number(recipientRows?.[0]?.c || 0)
    if (recipientCount !== Number(campaign.preview_recipient_count || 0)) {
      await runner(`UPDATE notification_campaigns SET status = 'needs_review', recipient_count = ? WHERE id = ?`, [recipientCount, campaignIdValue])
      return { status:'needs_review', recipientCount }
    }
    if (Number(campaign.email_enabled) === 1) {
      await runner(`INSERT IGNORE INTO notification_deliveries
        (campaign_id, user_id, channel, status, next_attempt_at)
        SELECT d.campaign_id, d.user_id, 'email',
          CASE WHEN u.email IS NOT NULL AND TRIM(u.email) <> '' AND u.email_verified = 1 THEN 'pending' ELSE 'skipped' END,
          CASE WHEN u.email IS NOT NULL AND TRIM(u.email) <> '' AND u.email_verified = 1 THEN NOW() ELSE NULL END
        FROM notification_deliveries d JOIN users u ON u.id = d.user_id
        WHERE d.campaign_id = ? AND d.channel = 'in_app'`, [campaignIdValue])
    }
    await runner(`UPDATE notification_campaigns SET status = 'sending', recipient_count = ? WHERE id = ?`, [recipientCount, campaignIdValue])
    return { status:'sending', recipientCount }
  })
}

async function deliverInApp(campaign) {
  let processed = 0
  while (true) {
    const rows = await queryAll(`SELECT d.id, d.user_id, d.notification_id
      FROM notification_deliveries d WHERE d.campaign_id = ? AND d.channel = 'in_app' AND d.status = 'pending'
      ORDER BY d.id ASC LIMIT 100`, [campaign.id])
    if (!rows.length) break
    for (const delivery of rows) {
      const currentUser = await queryOne(`SELECT id FROM users WHERE id = ?
        AND COALESCE(deletion_status, 'active') = 'active' AND deleted_at IS NULL`, [delivery.user_id])
      if (!currentUser) {
        await queryRun(`UPDATE notification_deliveries SET status = 'skipped', last_error = '账号已失效', updated_at = NOW()
          WHERE id = ? AND channel = 'in_app' AND status = 'pending'`, [delivery.id])
        continue
      }
      const dedupeKey = `notification-campaign-${campaign.id}-${delivery.user_id}`
      let notification = await queryOne(`SELECT id FROM notifications WHERE dedupe_key = ?`, [dedupeKey])
      if (!notification) {
        try {
          const result = await queryRun(`INSERT INTO notifications
            (user_id, type, title, message, link, dedupe_key, campaign_id, priority, requires_ack, is_read)
            VALUES (?, 'system', ?, ?, ?, ?, ?, ?, ?, 0)`, [
            delivery.user_id, campaign.title, campaign.message, campaign.link || '', dedupeKey,
            campaign.id, campaign.priority, Number(campaign.requires_ack) ? 1 : 0,
          ])
          notification = { id:result.insertId }
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY') throw error
          notification = await queryOne('SELECT id FROM notifications WHERE dedupe_key = ?', [dedupeKey])
        }
      }
      if (!notification?.id) continue
      const changed = await queryRun(`UPDATE notification_deliveries SET notification_id = ?, status = 'sent', sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
        WHERE id = ? AND channel = 'in_app' AND status = 'pending'`, [notification.id, delivery.id])
      if (Number(changed.changes || 0) > 0) {
        processed++
        const unread = await queryOne('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [delivery.user_id])
        try {
          sendNotificationCreatedToUser(delivery.user_id, {
            notificationId:Number(notification.id),
            priority:campaign.priority,
            requiresAck:Boolean(Number(campaign.requires_ack)),
            unreadCount:Number(unread?.c || 0),
          })
        } catch (error) {
          console.warn('[NotificationCenter] WebSocket notification wake failed:', error.message)
        }
      }
    }
  }
  await queryRun(`UPDATE notification_campaigns SET in_app_sent_count =
    (SELECT COUNT(*) FROM notification_deliveries WHERE campaign_id = ? AND channel = 'in_app' AND status = 'sent') WHERE id = ?`, [campaign.id, campaign.id])
  return processed
}

function emailMessageId(campaignIdValue, userId) {
  return `<aurum-notification-${Number(campaignIdValue)}-${Number(userId)}@aurum.local>`
}

export function notificationEmailMessageId(campaignIdValue, userId) {
  return emailMessageId(campaignIdValue, userId)
}

async function deliverEmail(campaign) {
  if (!Number(campaign.email_enabled)) return
  const rows = await queryAll(`SELECT d.id, d.user_id, d.attempt_count, u.email, u.email_verified,
      u.deletion_status, u.deleted_at
    FROM notification_deliveries d JOIN users u ON u.id = d.user_id
    WHERE d.campaign_id = ? AND d.channel = 'email'
      AND (d.status = 'pending' OR (d.status = 'failed' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= NOW()))
      ORDER BY d.id ASC LIMIT 100`, [campaign.id])
  for (const delivery of rows) {
    const claim = await queryRun(`UPDATE notification_deliveries SET status = 'sending', attempt_count = attempt_count + 1, updated_at = NOW()
      WHERE id = ? AND channel = 'email'
        AND (status = 'pending' OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= NOW()))`, [delivery.id])
    if (!Number(claim.changes || 0)) continue
    if (!delivery.email || Number(delivery.email_verified) !== 1 || String(delivery.deletion_status || 'active') !== 'active' || delivery.deleted_at) {
      await queryRun(`UPDATE notification_deliveries SET status = 'skipped', last_error = '邮箱未验证或账号已失效', updated_at = NOW() WHERE id = ?`, [delivery.id])
      continue
    }
    const messageId = emailMessageId(campaign.id, delivery.user_id)
    let result
    try {
      result = await sendUserNotificationEmail({
        to:delivery.email,
        title:campaign.title,
        message:campaign.message,
        link:campaign.link,
        messageId,
      })
    } catch (error) {
      // The email adapter normally classifies errors itself.  Keep the worker
      // recoverable if a provider adapter throws unexpectedly.
      result = { sent:false, status:'unknown', retryable:false, error:'邮件服务响应不明' }
      console.warn('[NotificationCenter] email adapter failed:', error.message)
    }
    const attempt = Number(delivery.attempt_count || 0) + 1
    if (result?.sent) {
      await queryRun(`UPDATE notification_deliveries SET status = 'sent', sent_at = COALESCE(sent_at, NOW()), message_id = ?,
        provider_response_summary = ?, last_error = NULL, updated_at = NOW() WHERE id = ?`, [messageId, String(result.providerResponseSummary || '').slice(0, 500), delivery.id])
    } else if (result?.status === 'unknown') {
      await queryRun(`UPDATE notification_deliveries SET status = 'unknown', message_id = ?, last_error = ?, updated_at = NOW() WHERE id = ?`, [messageId, String(result.error || '邮件服务响应不明').slice(0, 500), delivery.id])
    } else if (result?.retryable && attempt < MAX_EMAIL_ATTEMPTS) {
      const delayMinutes = Math.min(60, 2 ** Math.max(0, attempt - 1))
      await queryRun(`UPDATE notification_deliveries SET status = 'failed', next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE),
        message_id = ?, last_error = ?, updated_at = NOW() WHERE id = ?`, [delayMinutes, messageId, String(result.error || '邮件发送失败').slice(0, 500), delivery.id])
    } else {
      await queryRun(`UPDATE notification_deliveries SET status = 'failed', next_attempt_at = NULL, message_id = ?, last_error = ?, updated_at = NOW() WHERE id = ?`, [messageId, String(result?.error || '邮件发送失败').slice(0, 500), delivery.id])
    }
  }
  await queryRun(`UPDATE notification_campaigns SET
      email_sent_count = (SELECT COUNT(*) FROM notification_deliveries WHERE campaign_id = ? AND channel = 'email' AND status = 'sent'),
      email_failed_count = (SELECT COUNT(*) FROM notification_deliveries WHERE campaign_id = ? AND channel = 'email' AND status IN ('failed', 'unknown')),
      email_skipped_count = (SELECT COUNT(*) FROM notification_deliveries WHERE campaign_id = ? AND channel = 'email' AND status = 'skipped')
    WHERE id = ?`, [campaign.id, campaign.id, campaign.id, campaign.id])
}

async function finalizeCampaign(campaignIdValue) {
  const campaign = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignIdValue])
  if (!campaign) return null
  const pending = await queryOne(`SELECT COUNT(*) AS c FROM notification_deliveries
    WHERE campaign_id = ? AND (status IN ('pending', 'sending') OR (status = 'failed' AND next_attempt_at IS NOT NULL))`, [campaignIdValue])
  const failed = await queryOne(`SELECT COUNT(*) AS c FROM notification_deliveries
    WHERE campaign_id = ? AND (status = 'unknown' OR (status = 'failed' AND next_attempt_at IS NULL))`, [campaignIdValue])
  if (Number(pending?.c || 0) > 0) return campaign
  const status = ['cancelled', 'cancelling'].includes(campaign.status) ? 'cancelled'
    : Number(failed?.c || 0) > 0 ? 'partial_failed' : 'completed'
  await queryRun(`UPDATE notification_campaigns SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
    completed_at = COALESCE(completed_at, NOW()) WHERE id = ?`, [status, status, campaignIdValue])
  return queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignIdValue])
}

export async function processNotificationCampaign(campaignIdValue) {
  const id = campaignId(campaignIdValue)
  const materialized = await materializeCampaign(id)
  if (['missing', 'completed', 'partial_failed', 'cancelled', 'needs_review'].includes(materialized.status)) return materialized
  const campaign = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [id])
  if (!campaign) return { status:'missing' }
  if (campaign.status === 'cancelled') return { status:'cancelled' }
  if (campaign.status === 'cancelling') {
    await queryRun(`UPDATE notification_deliveries SET status = 'cancelled', updated_at = NOW()
      WHERE campaign_id = ? AND status IN ('pending', 'failed')`, [id])
    const final = await finalizeCampaign(id)
    return { status:final?.status || 'cancelling', campaign:final ? campaignToApi(final) : null }
  }
  await deliverInApp(campaign)
  await deliverEmail(campaign)
  const final = await finalizeCampaign(id)
  return { status:final?.status || 'sending', campaign:final ? campaignToApi(final) : null }
}

let workerTimer = null
let workerRunning = false
let workerStopped = true

export async function processNotificationQueueOnce() {
  if (workerRunning) return { running:true }
  workerRunning = true
  workerStopped = false
  try {
    await queryRun(`UPDATE notification_deliveries SET status = 'unknown', last_error = '服务重启后无法确认邮件是否已接受', updated_at = NOW()
      WHERE channel = 'email' AND status = 'sending' AND updated_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`)
    const campaigns = await queryAll(`SELECT id FROM notification_campaigns
      WHERE status IN ('queued', 'materializing', 'sending', 'cancelling') ORDER BY id ASC LIMIT 10`)
    const results = []
    for (const row of campaigns) {
      try { results.push(await processNotificationCampaign(row.id)) }
      catch (error) { console.error(`[NotificationCenter] campaign ${row.id} failed:`, error.message) }
    }
    return { running:false, results }
  } finally {
    workerRunning = false
  }
}

// Stable aliases make the one-shot worker easy to exercise from integration
// tests without coupling callers to the queue's internal naming.
export const processNotificationWorkerOnce = processNotificationQueueOnce
export const processNotificationCampaignOnce = processNotificationCampaign

export function startNotificationCenterWorker({ intervalMs = WORKER_INTERVAL_MS } = {}) {
  if (workerTimer) return workerTimer
  workerStopped = false
  processNotificationQueueOnce().catch(error => console.error('[NotificationCenter] initial worker failed:', error.message))
  workerTimer = setInterval(() => {
    if (workerStopped) return
    processNotificationQueueOnce().catch(error => console.error('[NotificationCenter] worker failed:', error.message))
  }, Math.max(500, Number(intervalMs) || WORKER_INTERVAL_MS))
  workerTimer.unref?.()
  return workerTimer
}

export async function stopNotificationCenterWorker() {
  workerStopped = true
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
  while (workerRunning) await new Promise(resolve => setTimeout(resolve, 10))
}

export const startNotificationWorker = startNotificationCenterWorker
export const stopNotificationWorker = stopNotificationCenterWorker

export function kickNotificationWorker() {
  if (!workerTimer && workerStopped) return
  processNotificationQueueOnce().catch(error => console.error('[NotificationCenter] queued worker failed:', error.message))
}

export async function listNotificationCampaigns({ page = 1, pageSize = 20, status = '' } = {}) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
  const where = status ? 'WHERE status = ?' : ''
  const params = status ? [String(status)] : []
  const total = await queryOne(`SELECT COUNT(*) AS c FROM notification_campaigns ${where}`, params)
  const rows = await queryAll(`SELECT * FROM notification_campaigns ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, safeSize, (safePage - 1) * safeSize])
  const totalCount = Number(total?.c || 0)
  const totalPages = Math.ceil(totalCount / safeSize)
  return { campaigns:rows.map(campaignToApi), pagination:{ page:safePage, pageSize:safeSize, page_size:safeSize, total:totalCount, totalPages, total_pages:totalPages } }
}

function maskEmail(value) {
  const text = String(value || '')
  const at = text.indexOf('@')
  if (at <= 0) return text ? '***' : ''
  return `${text.slice(0, Math.min(2, at))}***${text.slice(at)}`
}

export async function getNotificationCampaignDetails(id, { page = 1, pageSize = 50, status = '' } = {}) {
  const campaign = await queryOne('SELECT * FROM notification_campaigns WHERE id = ?', [campaignId(id)])
  if (!campaign) throw new NotificationError('campaign_not_found', undefined, 404)
  const safePage = Math.max(1, Number(page) || 1)
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 50))
  const params = [campaign.id]
  const statusWhere = status ? ' AND d.status = ?' : ''
  if (status) params.push(String(status))
  const total = await queryOne(`SELECT COUNT(*) AS c FROM notification_deliveries d WHERE d.campaign_id = ?${statusWhere}`, params)
  const rows = await queryAll(`SELECT d.*, u.uid, u.nickname, u.email FROM notification_deliveries d
    LEFT JOIN users u ON u.id = d.user_id WHERE d.campaign_id = ?${statusWhere}
    ORDER BY d.id ASC LIMIT ? OFFSET ?`, [...params, safeSize, (safePage - 1) * safeSize])
  return {
    campaign:campaignToApi(campaign),
    deliveries:rows.map(row => ({
      id:Number(row.id), userId:Number(row.user_id), uid:row.uid || '', nickname:row.nickname || '', email:maskEmail(row.email),
      channel:row.channel, status:row.status, attemptCount:Number(row.attempt_count || 0), notificationId:row.notification_id ? Number(row.notification_id) : null,
      sentAt:row.sent_at || null, readAt:row.read_at || null, acknowledgedAt:row.acknowledged_at || null,
      messageId:row.message_id || null, lastError:row.last_error || null, providerResponseSummary:row.provider_response_summary || null,
      createdAt:row.created_at || null, updatedAt:row.updated_at || null,
    })),
    pagination:{ page:safePage, pageSize:safeSize, page_size:safeSize, total:Number(total?.c || 0), totalPages:Math.ceil(Number(total?.c || 0) / safeSize), total_pages:Math.ceil(Number(total?.c || 0) / safeSize) },
  }
}
