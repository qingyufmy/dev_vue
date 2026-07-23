const PAID_PLANS = new Set(['plus', 'pro'])

function expiryTimestamp(value) {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const text = String(value).trim()
  if (!text) return null
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T23:59:59+08:00`
    : text.replace(' ', 'T')
  const timestamp = new Date(normalized).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export function isMembershipExpired(user, now = Date.now()) {
  const plan = String(user?.plan || 'free').toLowerCase()
  if (!PAID_PLANS.has(plan)) return false
  if (user?.membership_expired !== undefined && user?.membership_expired !== null) {
    return Boolean(Number(user.membership_expired))
  }
  const rawExpiry = user?.plan_expires_at ?? user?.planExpiresAt
  if (rawExpiry === null || rawExpiry === undefined || String(rawExpiry).trim() === '') return false
  const expiresAt = expiryTimestamp(rawExpiry)
  // A malformed non-null expiry must fail closed instead of granting an
  // effectively permanent membership.
  return expiresAt === null || expiresAt < Number(now)
}

export function getEffectivePlan(user, now = Date.now()) {
  const plan = String(user?.plan || 'free').toLowerCase()
  if (!PAID_PLANS.has(plan)) return 'free'
  return isMembershipExpired(user, now) ? 'free' : plan
}

export function hasActiveMembership(user, allowedPlans) {
  if (String(user?.role || '').toLowerCase() === 'admin') return true
  const allowed = Array.isArray(allowedPlans) ? allowedPlans : [allowedPlans]
  return allowed.includes(getEffectivePlan(user))
}

export function canAccessMembershipLevel(user, accessLevel = 'free') {
  const level = String(accessLevel || 'free').toLowerCase()
  if (level === 'free') return true
  if (level === 'logged_in') return Boolean(user?.id)
  if (level === 'plus_pro') return hasActiveMembership(user, ['plus', 'pro'])
  if (level === 'pro' || level === 'pro_only') return hasActiveMembership(user, 'pro')
  return false
}

export function decorateMembership(user, now = Date.now()) {
  if (!user) return user
  const membershipExpired = isMembershipExpired(user, now)
  return {
    ...user,
    membership_expired: membershipExpired ? 1 : 0,
    membershipExpired,
    effective_plan: membershipExpired ? 'free' : getEffectivePlan(user, now),
    effectivePlan: membershipExpired ? 'free' : getEffectivePlan(user, now),
  }
}
