import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { logAudit, queryOne, queryRun } from '../../db.js'

function normalizedEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('observer_source_email_invalid')
  }
  return email
}

function validatedPassword(value) {
  const password = String(value || '')
  if (password.length < 8 || password.length > 128 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('observer_source_password_invalid')
  }
  return password
}

function sourceUid() {
  return `OBS${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.toUpperCase()
}

export async function createObserverSourceAccount(actorId, input = {}) {
  const email = normalizedEmail(input.email)
  const password = validatedPassword(input.password)
  const nickname = String(input.nickname || '').trim().slice(0, 100) || `观摩源-${email.split('@')[0]}`
  if (await queryOne('SELECT id FROM users WHERE email = ?', [email])) throw new Error('observer_source_email_exists')

  const passwordHash = await bcrypt.hash(password, 10)
  let inserted
  try {
    inserted = await queryRun(`INSERT INTO users
      (uid, email, password, nickname, role, plan, plan_expires_at, plan_source,
        auth_method, email_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'user', 'pro', NULL, 'observer_source', 'email', 1, NOW(), NOW())`,
    [sourceUid(), email, passwordHash, nickname])
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw new Error('observer_source_email_exists')
    throw error
  }
  const account = await queryOne(`SELECT id, uid, email, nickname, role, plan, plan_source
    FROM users WHERE id = ?`, [inserted.insertId])
  await logAudit({
    userId:Number(actorId), action:'observer_source_account_created',
    targetType:'user', targetId:inserted.insertId,
    detail:JSON.stringify({ email, nickname, role:'user', plan:'pro', plan_source:'observer_source' }),
  })
  return account
}
