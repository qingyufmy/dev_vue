import nodemailer from 'nodemailer'
import { queryAll } from './db.js'
import { systemConfigRowsToMap } from './system-config-secrets.js'

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[char]))
}

export function classifyEmailSendError(error) {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()
  const responseCode = Number(error?.responseCode || 0)
  // Once SMTP DATA may have been submitted, a timeout/reset cannot tell us
  // whether the provider accepted the message.  Mark it unknown and never
  // automatically retry it; an administrator can make an informed decision.
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(code)
    || message.includes('timeout') || message.includes('timed out') || message.includes('connection reset')) {
    return { status:'unknown', retryable:false, code:code || 'smtp_timeout' }
  }
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return { status:'failed', retryable:true, code:code || 'smtp_connection_failed' }
  }
  if (responseCode >= 400 && responseCode < 500) return { status:'failed', retryable:true, code:`smtp_${responseCode}` }
  return { status:'failed', retryable:false, code:code || (responseCode ? `smtp_${responseCode}` : 'smtp_send_failed') }
}

export async function loadSmtpConfig() {
  const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
  return systemConfigRowsToMap(rows)
}

function createSmtpTransporter(cfg) {
  return nodemailer.createTransport({
    host:cfg.host,
    port:Number(cfg.port) || 587,
    secure:cfg.secure === 'true',
    auth:{ user:cfg.user, pass:cfg.pass },
    connectionTimeout:10000,
    greetingTimeout:10000,
    socketTimeout:15000,
  })
}

export async function listAdminAlertRecipients() {
  const rows = await queryAll(`SELECT DISTINCT email FROM users
    WHERE role = 'admin' AND email IS NOT NULL AND TRIM(email) <> ''
      AND deletion_status = 'active' AND deleted_at IS NULL`)
  return rows.map(row => String(row.email || '').trim()).filter(Boolean)
}

export async function sendSystemEmail({ to, subject, html }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean)
  if (!recipients.length) return { sent:false, reason:'no_recipients' }
  const cfg = await loadSmtpConfig()
  if (!cfg.host || !cfg.user) return { sent:false, reason:'smtp_not_configured' }
  const transporter = createSmtpTransporter(cfg)
  await transporter.sendMail({
    from:{ name:cfg.from_name || 'AURUM 系统告警', address:cfg.from || cfg.user },
    to:recipients.join(','),
    subject,
    html,
  })
  return { sent:true, recipients:recipients.length }
}

/**
 * Send one user notification.  This deliberately has no recipient-array
 * overload: every address gets an independent SMTP envelope, preventing
 * disclosure through To/Cc.  The caller supplies a deterministic Message-ID
 * so an operator can identify a manual retry without pretending that SMTP
 * guarantees exactly-once delivery.
 */
export async function sendUserNotificationEmail({ to, title, message, link = null, messageId = null } = {}) {
  const recipient = String(to || '').trim()
  if (!recipient) return { sent:false, status:'skipped', retryable:false, error:'未绑定已验证邮箱' }
  const cfg = await loadSmtpConfig()
  if (!cfg.host || !cfg.user) return { sent:false, status:'failed', retryable:false, error:'邮件服务未配置' }
  const safeTitle = String(title || '').normalize('NFC').slice(0, 100)
  const safeMessage = String(message || '').normalize('NFC').slice(0, 1000)
  const safeLink = typeof link === 'string' && (/^\/$|^\/(?:account|ai)(?:\/|\?)/.test(link)) ? link : null
  const siteUrl = String(process.env.PUBLIC_SITE_URL || 'https://www.cnfxtrade.com').replace(/\/+$/, '')
  const absoluteLink = safeLink ? `${siteUrl}${safeLink}` : null
  const text = [safeTitle, '', safeMessage, absoluteLink ? `查看详情：${absoluteLink}` : '', '', '这是一封来自量见平台的通知。'].filter(Boolean).join('\n')
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.7;color:#1f2937;max-width:640px">
    <h2>${escapeHtml(safeTitle)}</h2>
    <p style="white-space:pre-wrap">${escapeHtml(safeMessage)}</p>
    ${absoluteLink ? `<p><a href="${escapeHtml(absoluteLink)}">查看详情</a></p>` : ''}
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
    <p style="color:#6b7280;font-size:12px">这是一封来自量见平台的通知。</p>
  </div>`
  try {
    const info = await createSmtpTransporter(cfg).sendMail({
      from:{ name:cfg.from_name || '量见平台', address:cfg.from || cfg.user },
      to:recipient,
      subject:`【量见】${safeTitle}`,
      text,
      html,
      ...(messageId ? { messageId } : {}),
    })
    const providerResponseSummary = String(info?.response || '').slice(0, 500)
    return {
      sent:true,
      status:'sent',
      retryable:false,
      messageId:messageId || info?.messageId || null,
      providerResponseSummary,
    }
  } catch (error) {
    const classified = classifyEmailSendError(error)
    return { sent:false, ...classified, error:classified.status === 'unknown' ? '邮件服务响应不明' : '邮件发送失败' }
  }
}

export { escapeHtml }
