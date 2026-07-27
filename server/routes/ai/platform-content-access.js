const OBSERVER_SOURCE_PLAN = 'observer_source'

function normalizedIdentity(user = {}) {
  return {
    role: String(user.role || user.user_role || user.review_user_role || '').trim().toLowerCase(),
    planSource: String(user.plan_source || user.user_plan_source || user.review_user_plan_source || '').trim().toLowerCase(),
  }
}

export function isObserverSourceAccount(user) {
  const identity = normalizedIdentity(user)
  return identity.role === 'user' && identity.planSource === OBSERVER_SOURCE_PLAN
}

export function canManagePlatformAiContent(user) {
  return normalizedIdentity(user).role === 'admin' || isObserverSourceAccount(user)
}

export function platformAiContentManagerSql(userAlias = 'u') {
  return `(${userAlias}.role = 'admin' OR (${userAlias}.role = 'user' AND ${userAlias}.plan_source = '${OBSERVER_SOURCE_PLAN}'))`
}
