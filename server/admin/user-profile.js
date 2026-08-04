import bcrypt from 'bcryptjs'
import { beijingNow, logAudit, queryOne, queryRun, withTransaction } from '../db.js'
import { revokeBridgeRefreshSessions } from '../bridge-auth-session.js'
import { disconnectUserSockets } from '../bridge-ws.js'

const VALID_PLANS = new Set(['free', 'plus', 'pro'])
const VALID_ROLES = new Set(['user', 'admin'])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function has(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key)
}

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

export function translateAdminProfileError(error) {
  const code = String(error?.message || error || '')
  const messages = {
    invalid_user_id:'用户编号无效',
    user_not_found:'用户不存在',
    profile_update_required:'没有需要保存的修改',
    membership_plan_invalid:'会员等级无效',
    membership_expiry_invalid:'会员到期日期无效',
    observer_source_plan_locked:'观摩源账号必须保持 Pro 专业版',
    observer_source_role_locked:'观摩源账号不能设为管理员',
    observer_source_email_required:'观摩源账号必须保留登录邮箱',
    user_role_invalid:'用户角色无效',
    last_admin_required:'至少需要保留一个管理员账号',
    email_invalid:'邮箱格式不正确',
    contact_method_required:'邮箱和手机号至少需要保留一项',
    password_strength_insufficient:'密码至少 8 位，且必须同时包含字母和数字',
    password_too_long:'密码不能超过 128 位',
  }
  if (error?.code === 'ER_DUP_ENTRY') return '邮箱或手机号已被其他用户使用'
  if (error?.code === 'ER_DATA_TOO_LONG') return '填写内容过长'
  return messages[code] || '保存用户档案失败'
}

/**
 * 统一管理后台的用户档案写入口。
 * 统一管理后台必须复用此函数，避免用户档案权限与校验规则漂移。
 */
export async function updateAdminUserProfile({ actorUserId, targetUserId, input = {} } = {}) {
  const uid = Number(targetUserId)
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('invalid_user_id')

  const target = await queryOne(`SELECT id, email, phone, nickname, avatar, role, plan,
    plan_expires_at, plan_source FROM users WHERE id = ?`, [uid])
  if (!target) throw new Error('user_not_found')

  const hasPlan = has(input, 'plan')
  const hasExpiry = has(input, 'expires_at') || has(input, 'expiresAt')
  const hasRole = has(input, 'role')
  const hasEmail = has(input, 'email')
  const hasPhone = has(input, 'phone')
  const hasNickname = has(input, 'nickname')
  const hasAvatar = has(input, 'avatar')
  const password = validatePassword(input.password)
  if (!hasPlan && !hasExpiry && !hasRole && !hasEmail && !hasPhone && !hasNickname && !hasAvatar && !password) {
    throw new Error('profile_update_required')
  }

  const plan = hasPlan ? String(input.plan || '').trim().toLowerCase() : String(target.plan || 'free')
  if (!VALID_PLANS.has(plan)) throw new Error('membership_plan_invalid')
  if (target.plan_source === 'observer_source' && plan !== 'pro') throw new Error('observer_source_plan_locked')

  const role = hasRole ? String(input.role || '').trim().toLowerCase() : String(target.role || 'user')
  if (!VALID_ROLES.has(role)) throw new Error('user_role_invalid')
  if (target.plan_source === 'observer_source' && role !== 'user') throw new Error('observer_source_role_locked')
  if (hasRole && target.role === 'admin' && role !== 'admin') {
    const row = await queryOne("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND COALESCE(deletion_status, '') <> 'anonymized'")
    if (Number(row?.count || 0) <= 1) throw new Error('last_admin_required')
  }

  const emailInput = hasEmail ? String(input.email || '').trim().toLowerCase() : target.email
  const email = emailInput || null
  if (hasEmail && email && !EMAIL.test(email)) throw new Error('email_invalid')
  const phone = hasPhone ? String(input.phone || '').trim().replace(/^\+86/, '') || null : target.phone
  const previouslyHadContact = Boolean(target.email || target.phone)
  if (!email && !phone && previouslyHadContact) throw new Error('contact_method_required')
  if (target.plan_source === 'observer_source' && !email) throw new Error('observer_source_email_required')
  const nickname = hasNickname ? String(input.nickname || '').trim() || null : target.nickname
  const avatar = hasAvatar ? String(input.avatar || '').trim() : target.avatar
  const currentExpiry = target.plan_expires_at instanceof Date
    ? target.plan_expires_at.toISOString().slice(0, 10)
    : String(target.plan_expires_at || '').slice(0, 10)
  const expiryInput = has(input, 'expires_at') ? input.expires_at : input.expiresAt
  const expiry = normalizeExpiry(plan, hasExpiry ? expiryInput : currentExpiry)

  const targetEmail = target.email ? String(target.email).trim().toLowerCase() : null
  const targetRole = String(target.role || 'user').trim().toLowerCase()
  const targetPlan = String(target.plan || 'free').trim().toLowerCase()
  const dateOnly = value => value == null || String(value).trim() === ''
    ? null : String(value).slice(0, 10)
  const sensitiveChange = Boolean(password)
    || email !== targetEmail
    || role !== targetRole
    || plan !== targetPlan
    || dateOnly(expiry) !== dateOnly(targetPlan === 'free' ? null : currentExpiry)

  const now = beijingNow()
  const updates = [
    'email = ?', 'phone = ?', 'nickname = ?', 'avatar = ?', 'role = ?',
    'plan = ?', 'plan_expires_at = ?', 'updated_at = ?',
  ]
  const params = [email, phone, nickname, avatar, role, plan, expiry, now]
  if (plan === 'free') updates.push('plan_source = NULL')
  if (password) {
    updates.push('password = ?')
    params.push(await bcrypt.hash(password, 10))
  }
  if (sensitiveChange) updates.push('token_version = token_version + 1')
  params.push(uid)
  const updateSql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
  if (sensitiveChange) {
    await withTransaction(async run => {
      await run(updateSql, params)
      await revokeBridgeRefreshSessions(uid, { run })
    })
    disconnectUserSockets(uid, password ? 'Password reset by administrator' : 'Account permissions changed')
  } else {
    await queryRun(updateSql, params)
  }

  const changed = {
    previous_plan:target.plan,
    plan,
    previous_expires_at:target.plan_expires_at || null,
    expires_at:expiry,
    previous_role:target.role,
    role,
    email_changed:email !== target.email,
    phone_changed:phone !== target.phone,
    nickname_changed:nickname !== target.nickname,
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
    email,
    phone,
    nickname,
    avatar,
    role,
    plan,
    plan_expires_at:expiry,
    membership_expired:Boolean(plan !== 'free' && expiry && expiry < now),
    password_reset:Boolean(password),
  }
}
