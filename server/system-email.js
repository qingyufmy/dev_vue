import nodemailer from 'nodemailer'
import { queryAll } from './db.js'
import { systemConfigRowsToMap } from './system-config-secrets.js'

export async function listAdminAlertRecipients() {
  const rows = await queryAll(`SELECT DISTINCT email FROM users
    WHERE role = 'admin' AND email IS NOT NULL AND TRIM(email) <> ''
      AND deletion_status = 'active' AND deleted_at IS NULL`)
  return rows.map(row => String(row.email || '').trim()).filter(Boolean)
}

export async function sendSystemEmail({ to, subject, html }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean)
  if (!recipients.length) return { sent:false, reason:'no_recipients' }
  const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
  const cfg = systemConfigRowsToMap(rows)
  if (!cfg.host || !cfg.user) return { sent:false, reason:'smtp_not_configured' }
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
    from:{ name:cfg.from_name || 'AURUM 系统告警', address:cfg.from || cfg.user },
    to:recipients.join(','),
    subject,
    html,
  })
  return { sent:true, recipients:recipients.length }
}
