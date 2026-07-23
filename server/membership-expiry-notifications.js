import nodemailer from 'nodemailer'
import { queryAll, queryOne, queryRun } from './db.js'
import { loadSmsConfig, sendSms } from './sms.js'

export const MEMBERSHIP_EXPIRY_REMINDER_DAYS = Object.freeze([7, 3, 2, 1])
export const MEMBERSHIP_EXPIRED_REMINDER_DAY = 0
const DELIVERY_CHANNELS = Object.freeze(['web_main', 'web_ai', 'email', 'sms'])
const MAX_DELIVERY_ATTEMPTS = 24
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

let workerTimer = null

function planLabel(plan) {
  return String(plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Plus'
}

function expiryDate(value) {
  return String(value || '').slice(0, 10)
}

function displayExpiryDate(value) {
  const [year, month, day] = expiryDate(value).split('-')
  return year && month && day ? `${year}年${Number(month)}月${Number(day)}日` : expiryDate(value)
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function safeError(error) {
  return String(error?.message || error || '通知发送失败').slice(0, 500)
}

export function normalizeReminderSurface(surface) {
  return String(surface || '').toLowerCase() === 'ai' ? 'web_ai' : 'web_main'
}

export function membershipDeliveryErrorText(error) {
  const text = String(error || '').trim()
  if (!text) return ''
  if (/未绑定邮箱/.test(text)) return '用户未绑定邮箱'
  if (/未绑定手机号/.test(text)) return '用户未绑定手机号'
  if (/短信模板|template/i.test(text)) return '短信模板未配置或模板不可用'
  if (/签名|signname|signature/i.test(text)) return '短信签名未配置或未通过审核'
  if (/余额|quota|balance|amount/i.test(text)) return '短信账户余额或发送额度不足'
  if (/频率|limit|business_control/i.test(text)) return '发送频率受到服务商限制，请稍后重试'
  if (/手机号|mobile|phone/i.test(text)) return '手机号格式无效或当前号码不可接收短信'
  if (/auth|login|credential|password|535/i.test(text)) return '通知服务账号认证失败，请检查服务配置'
  if (/timeout|timed out|etimedout/i.test(text)) return '通知服务连接超时，请稍后重试'
  if (/connection|connect|econn/i.test(text)) return '无法连接通知服务，请检查网络和服务地址'
  if (/会员续费|提醒窗口/.test(text)) return '会员已续费或当前提醒窗口已经变化'
  return '通知服务返回异常，请查看服务器日志后重试'
}

export function buildMembershipExpiryCopy({ plan, plan_expires_at: planExpiresAt, days_before: daysBefore }) {
  const label = planLabel(plan)
  const days = Number(daysBefore)
  const date = displayExpiryDate(planExpiresAt)
  const expired = days === MEMBERSHIP_EXPIRED_REMINDER_DAY
  return {
    title:expired ? `${label} 会员已过期` : `${label} 会员将在 ${days} 天后到期`,
    summary:expired
      ? `您的 ${label} 会员已于 ${date}到期，续费后可恢复会员权益。`
      : `您的 ${label} 会员有效期至 ${date}，续费后可继续使用当前会员权益。`,
    plan_label:label,
    expiry_date:expiryDate(planExpiresAt),
    expiry_date_text:date,
    days_before:days,
  }
}

export async function ensureMembershipExpiryNotifications(userId = null) {
  const params = [...MEMBERSHIP_EXPIRY_REMINDER_DAYS]
  let userFilter = ''
  if (Number(userId) > 0) {
    userFilter = 'AND id = ?'
    params.push(Number(userId))
  }
  const users = await queryAll(`SELECT id, email, phone, nickname, plan, plan_expires_at,
      CASE WHEN plan_expires_at < NOW() THEN 0
        ELSE DATEDIFF(DATE(plan_expires_at), CURDATE()) END AS days_before
    FROM users
    WHERE role <> 'admin' AND deletion_status = 'active' AND deleted_at IS NULL
      AND plan IN ('plus', 'pro') AND plan_expires_at IS NOT NULL
      AND (DATEDIFF(DATE(plan_expires_at), CURDATE()) IN (?, ?, ?, ?)
        OR plan_expires_at < NOW())
      ${userFilter}`, params)

  let created = 0
  for (const user of users) {
    const channels = DELIVERY_CHANNELS.filter(channel => channel !== 'sms' || String(user.phone || '').trim())
    for (const channel of channels) {
      const result = await queryRun(`INSERT IGNORE INTO membership_expiry_notifications
        (user_id, plan, plan_expires_at, days_before, channel, status, attempt_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, NOW(), NOW())`, [
        user.id, user.plan, user.plan_expires_at, Number(user.days_before), channel,
      ])
      created += Number(result.changes || 0)
    }
  }
  return { users:users.length, created }
}

export async function cancelStaleMembershipExpiryNotifications() {
  const result = await queryRun(`UPDATE membership_expiry_notifications notifications
    LEFT JOIN users ON users.id = notifications.user_id
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL
    SET notifications.status = 'cancelled',
        notifications.next_attempt_at = NULL,
        notifications.last_error = '会员续费或提醒窗口已变化',
        notifications.updated_at = NOW()
    WHERE notifications.status IN ('pending', 'failed', 'sending')
      AND (users.id IS NULL OR users.plan <> notifications.plan
        OR users.plan_expires_at <> notifications.plan_expires_at
        OR (notifications.channel = 'sms' AND NULLIF(TRIM(users.phone), '') IS NULL)
        OR (notifications.days_before = 0 AND users.plan_expires_at >= NOW())
        OR (notifications.days_before > 0
          AND DATEDIFF(DATE(notifications.plan_expires_at), CURDATE()) <> notifications.days_before))`)
  return Number(result.changes || 0)
}

async function loadSmtpConfig() {
  const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
  return Object.fromEntries(rows.map(row => [row.key, row.value]))
}

export async function sendMembershipExpiryEmail(delivery) {
  if (!delivery.email) throw new Error('用户未绑定邮箱')
  const cfg = await loadSmtpConfig()
  if (!cfg.host || !cfg.user) throw new Error('SMTP 邮件服务未配置')
  const copy = buildMembershipExpiryCopy(delivery)
  const siteUrl = String(process.env.PUBLIC_SITE_URL || 'https://www.cnfxtrade.com').replace(/\/+$/, '')
  const transporter = nodemailer.createTransport({
    host:cfg.host,
    port:Number(cfg.port) || 587,
    secure:cfg.secure === 'true',
    auth:{ user:cfg.user, pass:cfg.pass },
    connectionTimeout:10000,
    greetingTimeout:10000,
    socketTimeout:15000,
  })
  await transporter.sendMail({
    from:{ name:cfg.from_name || '量见课堂', address:cfg.from || cfg.user },
    to:delivery.email,
    subject:`【量见】${copy.title}`,
    html:`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#172033;line-height:1.7">
      <div style="padding:28px;border:1px solid #e5e7eb;border-radius:16px;background:#ffffff">
        <p style="margin:0 0 8px;color:#9a7412;font-size:13px;font-weight:700">会员到期提醒</p>
        <h2 style="margin:0 0 14px;font-size:24px">${escapeHtml(copy.title)}</h2>
        <p style="margin:0 0 22px;color:#526079">${escapeHtml(copy.summary)}</p>
        <a href="${siteUrl}/membership" style="display:inline-block;padding:11px 20px;border-radius:9px;background:#d5ad35;color:#111827;text-decoration:none;font-weight:700">前往续费</a>
        <p style="margin:22px 0 0;color:#8792a6;font-size:12px">如您已经完成续费，请忽略本邮件，系统会自动更新会员有效期。</p>
      </div>
    </div>`,
  })
}

export async function sendMembershipExpirySms(delivery) {
  if (!delivery.phone) throw new Error('用户未绑定手机号')
  const cfg = await loadSmsConfig()
  const copy = buildMembershipExpiryCopy(delivery)
  const expired = copy.days_before === MEMBERSHIP_EXPIRED_REMINDER_DAY
  const templateCode = expired ? cfg.templateCodes.membership_expired : cfg.templateCodes.membership_expiry
  if (!templateCode) throw new Error(expired ? '会员已过期短信模板未配置' : '会员到期提醒短信模板未配置')
  const templateParams = { plan:copy.plan_label, expire_date:copy.expiry_date }
  if (!expired) templateParams.days = String(copy.days_before)
  await sendSms(delivery.phone, templateCode, templateParams)
}

async function completeDelivery(id, status, error = null) {
  if (status === 'sent') {
    return queryRun(`UPDATE membership_expiry_notifications
      SET status = 'sent', sent_at = NOW(), next_attempt_at = NULL, last_error = NULL, updated_at = NOW()
      WHERE id = ? AND status = 'sending'`, [id])
  }
  if (status === 'skipped') {
    return queryRun(`UPDATE membership_expiry_notifications
      SET status = 'skipped', next_attempt_at = NULL, last_error = ?, updated_at = NOW()
      WHERE id = ? AND status = 'sending'`, [safeError(error), id])
  }
  return queryRun(`UPDATE membership_expiry_notifications
    SET status = 'failed', next_attempt_at = DATE_ADD(NOW(), INTERVAL 1 HOUR), last_error = ?, updated_at = NOW()
    WHERE id = ? AND status = 'sending'`, [safeError(error), id])
}

export async function processMembershipExpiryDeliveries(limit = 100, deliveryId = null) {
  const smtpConfig = await loadSmtpConfig().catch(() => ({}))
  const smsConfig = await loadSmsConfig().catch(() => ({ templateCodes:{} }))
  const idFilter = Number(deliveryId) > 0 ? 'AND notifications.id = ?' : ''
  const params = [MAX_DELIVERY_ATTEMPTS]
  if (idFilter) params.push(Number(deliveryId))
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  const deliveries = await queryAll(`SELECT notifications.*, users.email, users.phone, users.nickname
    FROM membership_expiry_notifications notifications
    JOIN users ON users.id = notifications.user_id
      AND users.plan = notifications.plan AND users.plan_expires_at = notifications.plan_expires_at
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL
    WHERE notifications.channel IN ('email', 'sms')
      AND notifications.status IN ('pending', 'failed')
      AND notifications.attempt_count < ?
      AND (notifications.next_attempt_at IS NULL OR notifications.next_attempt_at <= NOW())
      AND (notifications.channel <> 'sms' OR NULLIF(TRIM(users.phone), '') IS NOT NULL)
      AND ((notifications.days_before = 0 AND notifications.plan_expires_at < NOW())
        OR (notifications.days_before > 0
          AND DATEDIFF(DATE(notifications.plan_expires_at), CURDATE()) = notifications.days_before))
      ${idFilter}
    ORDER BY notifications.id LIMIT ?`, params)

  const result = { selected:deliveries.length, sent:0, failed:0, skipped:0, deferred:0 }
  for (const delivery of deliveries) {
    const providerReady = delivery.channel === 'email'
      ? Boolean(smtpConfig.host && smtpConfig.user)
      : Boolean(Number(delivery.days_before) === MEMBERSHIP_EXPIRED_REMINDER_DAY
        ? smsConfig.templateCodes?.membership_expired
        : smsConfig.templateCodes?.membership_expiry)
    if (!providerReady) {
      result.deferred++
      continue
    }
    const claimed = await queryRun(`UPDATE membership_expiry_notifications
      SET status = 'sending', attempt_count = attempt_count + 1, updated_at = NOW()
      WHERE id = ? AND status IN ('pending', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`, [delivery.id])
    if (!claimed.changes) continue
    if ((delivery.channel === 'email' && !delivery.email) || (delivery.channel === 'sms' && !delivery.phone)) {
      await completeDelivery(delivery.id, 'skipped', delivery.channel === 'email' ? '用户未绑定邮箱' : '用户未绑定手机号')
      result.skipped++
      continue
    }
    try {
      if (delivery.channel === 'email') await sendMembershipExpiryEmail(delivery)
      else await sendMembershipExpirySms(delivery)
      await completeDelivery(delivery.id, 'sent')
      result.sent++
    } catch (error) {
      await completeDelivery(delivery.id, 'failed', error)
      result.failed++
      console.error(`[MembershipExpiry] ${delivery.channel} delivery ${delivery.id} failed: ${safeError(error)}`)
    }
  }
  return result
}

export async function runMembershipExpiryNotificationCycle() {
  const cancelled = await cancelStaleMembershipExpiryNotifications()
  const seeded = await ensureMembershipExpiryNotifications()
  const delivered = await processMembershipExpiryDeliveries()
  if (cancelled || seeded.created || delivered.selected) {
    console.log(`[MembershipExpiry] cancelled=${cancelled} users=${seeded.users} created=${seeded.created} sent=${delivered.sent} failed=${delivered.failed} skipped=${delivered.skipped} deferred=${delivered.deferred}`)
  }
  return { cancelled, ...seeded, ...delivered }
}

export function startMembershipExpiryNotificationWorker(intervalMs = DEFAULT_INTERVAL_MS) {
  if (workerTimer) return workerTimer
  const run = () => runMembershipExpiryNotificationCycle()
    .catch(error => console.error('[MembershipExpiry] cycle failed:', safeError(error)))
  void run()
  workerTimer = setInterval(run, Math.max(60_000, Number(intervalMs) || DEFAULT_INTERVAL_MS))
  workerTimer.unref?.()
  return workerTimer
}

export async function getPendingWebMembershipReminder(userId, surface = 'main') {
  await ensureMembershipExpiryNotifications(userId)
  const channel = normalizeReminderSurface(surface)
  const row = await queryOne(`SELECT notifications.id, notifications.plan, notifications.plan_expires_at,
      notifications.days_before, notifications.created_at
    FROM membership_expiry_notifications notifications
    JOIN users ON users.id = notifications.user_id
      AND users.plan = notifications.plan AND users.plan_expires_at = notifications.plan_expires_at
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL
    WHERE notifications.user_id = ? AND notifications.channel = ? AND notifications.status = 'pending'
      AND ((notifications.days_before = 0 AND notifications.plan_expires_at < NOW())
        OR (notifications.days_before > 0
          AND DATEDIFF(DATE(notifications.plan_expires_at), CURDATE()) = notifications.days_before))
    ORDER BY notifications.days_before ASC, notifications.id DESC LIMIT 1`, [Number(userId), channel])
  return row ? { ...row, ...buildMembershipExpiryCopy(row) } : null
}

export async function acknowledgeWebMembershipReminder(userId, reminderId, surface = 'main') {
  const result = await queryRun(`UPDATE membership_expiry_notifications
    SET status = 'read', read_at = NOW(), updated_at = NOW()
    WHERE id = ? AND user_id = ? AND channel = ? AND status = 'pending'`, [
    Number(reminderId), Number(userId), normalizeReminderSurface(surface),
  ])
  return result.changes > 0
}

export async function getAdminMembershipExpiryNotifications(options = {}) {
  const page = Math.max(1, Number(options.page) || 1)
  const pageSize = Math.max(5, Math.min(50, Number(options.pageSize) || 10))
  const allowedChannels = new Set(DELIVERY_CHANNELS)
  const allowedStatuses = new Set(['pending', 'sending', 'sent', 'read', 'failed', 'skipped', 'cancelled'])
  const where = []
  const params = []
  if (allowedChannels.has(options.channel)) { where.push('notifications.channel = ?'); params.push(options.channel) }
  if (allowedStatuses.has(options.status)) { where.push('notifications.status = ?'); params.push(options.status) }
  if ([MEMBERSHIP_EXPIRED_REMINDER_DAY, ...MEMBERSHIP_EXPIRY_REMINDER_DAYS].includes(Number(options.daysBefore))
      && String(options.daysBefore ?? '') !== '') {
    where.push('notifications.days_before = ?')
    params.push(Number(options.daysBefore))
  }
  const search = String(options.search || '').trim().slice(0, 100)
  if (search) {
    const pattern = `%${search}%`
    where.push('(users.nickname LIKE ? OR users.email LIKE ? OR users.phone LIKE ? OR CAST(users.id AS CHAR) = ?)')
    params.push(pattern, pattern, pattern, search)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const smtpConfig = await loadSmtpConfig().catch(() => ({}))
  const smsConfig = await loadSmsConfig().catch(() => ({ templateCodes:{} }))
  const [summaryRows, countRow, rows] = await Promise.all([
    queryAll(`SELECT status, channel, COUNT(*) AS count
      FROM membership_expiry_notifications GROUP BY status, channel`),
    queryOne(`SELECT COUNT(*) AS count FROM membership_expiry_notifications notifications
      LEFT JOIN users ON users.id = notifications.user_id ${whereSql}`, params),
    queryAll(`SELECT notifications.id, notifications.user_id, notifications.plan,
        notifications.plan_expires_at, notifications.days_before, notifications.channel,
        notifications.status, notifications.attempt_count, notifications.next_attempt_at,
        notifications.sent_at, notifications.read_at, notifications.last_error,
        notifications.created_at, notifications.updated_at,
        users.nickname, users.email, users.phone
      FROM membership_expiry_notifications notifications
      LEFT JOIN users ON users.id = notifications.user_id
      ${whereSql}
      ORDER BY notifications.created_at DESC, notifications.id DESC
      LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
  ])
  const providerConfigured = {
    email:Boolean(smtpConfig.host && smtpConfig.user),
    sms:Boolean(smsConfig.templateCodes?.membership_expiry && smsConfig.templateCodes?.membership_expired),
    sms_expiry:Boolean(smsConfig.templateCodes?.membership_expiry),
    sms_expired:Boolean(smsConfig.templateCodes?.membership_expired),
  }
  const summary = { total:0, pending:0, sent:0, read:0, failed:0, skipped:0, cancelled:0 }
  for (const row of summaryRows) {
    const count = Number(row.count || 0)
    summary.total += count
    if (Object.hasOwn(summary, row.status)) summary[row.status] += count
  }
  return {
    page, pageSize, total:Number(countRow?.count || 0), summary, providerConfigured,
    records:rows.map(row => {
      const { last_error:rawError, ...safeRow } = row
      const waitingConfiguration = row.status === 'pending'
        && ((row.channel === 'email' && !providerConfigured.email)
          || (row.channel === 'sms' && Number(row.days_before) === MEMBERSHIP_EXPIRED_REMINDER_DAY && !providerConfigured.sms_expired)
          || (row.channel === 'sms' && Number(row.days_before) > MEMBERSHIP_EXPIRED_REMINDER_DAY && !providerConfigured.sms_expiry))
      return {
        ...safeRow,
        delivery_state:waitingConfiguration ? 'waiting_configuration' : row.status,
        error_text:membershipDeliveryErrorText(rawError),
        retry_allowed:row.status === 'failed' && ['email', 'sms'].includes(row.channel),
      }
    }),
  }
}

export async function retryMembershipExpiryNotification(deliveryId) {
  const id = Number(deliveryId)
  if (!Number.isInteger(id) || id <= 0) return { ok:false, reason:'not_found' }
  const eligible = await queryOne(`SELECT notifications.id
    FROM membership_expiry_notifications notifications
    JOIN users ON users.id = notifications.user_id
      AND users.plan = notifications.plan AND users.plan_expires_at = notifications.plan_expires_at
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL
    WHERE notifications.id = ? AND notifications.channel IN ('email', 'sms')
      AND notifications.status = 'failed'
      AND (notifications.channel <> 'sms' OR NULLIF(TRIM(users.phone), '') IS NOT NULL)
      AND ((notifications.days_before = 0 AND notifications.plan_expires_at < NOW())
        OR (notifications.days_before > 0
          AND DATEDIFF(DATE(notifications.plan_expires_at), CURDATE()) = notifications.days_before))`, [id])
  if (!eligible) return { ok:false, reason:'not_retryable' }
  const reset = await queryRun(`UPDATE membership_expiry_notifications
    SET status = 'pending', attempt_count = 0, next_attempt_at = NULL,
      last_error = NULL, updated_at = NOW()
    WHERE id = ? AND status = 'failed'`, [id])
  if (!reset.changes) return { ok:false, reason:'not_retryable' }
  const delivery = await processMembershipExpiryDeliveries(1, id)
  const current = await queryOne('SELECT status, last_error FROM membership_expiry_notifications WHERE id = ?', [id])
  return {
    ok:true,
    status:current?.status || 'pending',
    error_text:membershipDeliveryErrorText(current?.last_error),
    deferred:delivery.deferred > 0,
  }
}
