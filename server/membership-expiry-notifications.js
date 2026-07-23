import nodemailer from 'nodemailer'
import { queryAll, queryOne, queryRun } from './db.js'
import { loadSmsConfig, sendSms } from './sms.js'

export const MEMBERSHIP_EXPIRY_REMINDER_DAYS = Object.freeze([7, 3, 2, 1])
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

export function buildMembershipExpiryCopy({ plan, plan_expires_at: planExpiresAt, days_before: daysBefore }) {
  const label = planLabel(plan)
  const days = Number(daysBefore)
  const date = displayExpiryDate(planExpiresAt)
  return {
    title:`${label} 会员将在 ${days} 天后到期`,
    summary:`您的 ${label} 会员有效期至 ${date}，续费后可继续使用当前会员权益。`,
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
      DATEDIFF(DATE(plan_expires_at), CURDATE()) AS days_before
    FROM users
    WHERE role <> 'admin' AND plan IN ('plus', 'pro') AND plan_expires_at IS NOT NULL
      AND DATEDIFF(DATE(plan_expires_at), CURDATE()) IN (?, ?, ?, ?)
      ${userFilter}`, params)

  let created = 0
  for (const user of users) {
    for (const channel of DELIVERY_CHANNELS) {
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
  const templateCode = cfg.templateCodes.membership_expiry
  if (!templateCode) throw new Error('会员到期提醒短信模板未配置')
  const copy = buildMembershipExpiryCopy(delivery)
  await sendSms(delivery.phone, templateCode, {
    plan:copy.plan_label,
    expire_date:copy.expiry_date,
    days:String(copy.days_before),
  })
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

export async function processMembershipExpiryDeliveries(limit = 100) {
  const smtpConfig = await loadSmtpConfig().catch(() => ({}))
  const smsConfig = await loadSmsConfig().catch(() => ({ templateCodes:{} }))
  const deliveries = await queryAll(`SELECT notifications.*, users.email, users.phone, users.nickname
    FROM membership_expiry_notifications notifications
    JOIN users ON users.id = notifications.user_id
      AND users.plan = notifications.plan AND users.plan_expires_at = notifications.plan_expires_at
    WHERE notifications.channel IN ('email', 'sms')
      AND notifications.status IN ('pending', 'failed')
      AND notifications.attempt_count < ?
      AND (notifications.next_attempt_at IS NULL OR notifications.next_attempt_at <= NOW())
      AND DATEDIFF(DATE(notifications.plan_expires_at), CURDATE()) = notifications.days_before
    ORDER BY notifications.id LIMIT ?`, [MAX_DELIVERY_ATTEMPTS, Math.max(1, Math.min(500, Number(limit) || 100))])

  const result = { selected:deliveries.length, sent:0, failed:0, skipped:0, deferred:0 }
  for (const delivery of deliveries) {
    const providerReady = delivery.channel === 'email'
      ? Boolean(smtpConfig.host && smtpConfig.user)
      : Boolean(smsConfig.templateCodes?.membership_expiry)
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
  const seeded = await ensureMembershipExpiryNotifications()
  const delivered = await processMembershipExpiryDeliveries()
  if (seeded.created || delivered.selected) {
    console.log(`[MembershipExpiry] users=${seeded.users} created=${seeded.created} sent=${delivered.sent} failed=${delivered.failed} skipped=${delivered.skipped} deferred=${delivered.deferred}`)
  }
  return { ...seeded, ...delivered }
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
    WHERE notifications.user_id = ? AND notifications.channel = ? AND notifications.status = 'pending'
      AND DATEDIFF(DATE(notifications.plan_expires_at), CURDATE()) = notifications.days_before
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
