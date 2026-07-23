import bcrypt from 'bcryptjs'
import { beijingNow, logAudit, queryOne, queryRun } from '../../db.js'
import { revokeBridgeRefreshSessions } from '../../bridge-auth-session.js'

const VALID_PLANS = new Set(['free', 'plus', 'pro'])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function normalizeExpiry(plan, rawValue) {
  if (plan === 'free' || rawValue == null || String(rawValue).trim() === '') return null
  const value = String(rawValue).trim()
  if (!DATE_ONLY.test(value)) throw new Error('membership_expiry_invalid')
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('membership_expiry_invalid')
  }
  return `${value} 23:59:59`
}

function validatePassword(rawValue) {
  const password = String(rawValue || '')
  if (!password) return ''
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('password_strength_insufficient')
  }
  if (password.length > 128) throw new Error('password_too_long')
  return password
}

export async function updateAdminUserProfile({ actorUserId, targetUserId, input = {} } = {}) {
  const uid = Number(targetUserId)
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('invalid_user_id')

  const target = await queryOne('SELECT id, plan, plan_expires_at, plan_source FROM users WHERE id = ?', [uid])
  if (!target) throw new Error('user_not_found')

  const hasPlan = Object.prototype.hasOwnProperty.call(input, 'plan')
  const hasExpiry = Object.prototype.hasOwnProperty.call(input, 'expires_at')
  const password = validatePassword(input.password)
  if (!hasPlan && !hasExpiry && !password) throw new Error('profile_update_required')

  const plan = hasPlan ? String(input.plan || '').trim().toLowerCase() : String(target.plan || 'free')
  if (!VALID_PLANS.has(plan)) throw new Error('membership_plan_invalid')
  if (target.plan_source === 'observer_source' && plan !== 'pro') {
    throw new Error('observer_source_plan_locked')
  }
  const currentExpiry = target.plan_expires_at instanceof Date
    ? target.plan_expires_at.toISOString().slice(0, 10)
    : String(target.plan_expires_at || '').slice(0, 10)
  const expiry = normalizeExpiry(plan, hasExpiry ? input.expires_at : currentExpiry)

  const now = beijingNow()
  const updates = ['plan = ?', 'plan_expires_at = ?', 'updated_at = ?']
  const params = [plan, expiry, now]
  if (plan === 'free') updates.push('plan_source = NULL')
  if (password) {
    updates.push('password = ?')
    params.push(await bcrypt.hash(password, 10))
  }
  params.push(uid)
  await queryRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params)
  if (password) await revokeBridgeRefreshSessions(uid)

  const changed = {
    previous_plan:target.plan,
    plan,
    previous_expires_at:target.plan_expires_at || null,
    expires_at:expiry,
    password_reset:Boolean(password),
  }
  await logAudit({
    userId:Number(actorUserId) || null,
    action:'admin_user_profile_updated',
    targetType:'user',
    targetId:uid,
    detail:JSON.stringify(changed),
  })
  return {
    id:uid,
    plan,
    plan_expires_at:expiry,
    membership_expired:Boolean(plan !== 'free' && expiry && expiry < now),
    password_reset:Boolean(password),
  }
}
