import { exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { representIdentityValue } from './v4-identity-values.mjs'

export function inspectUserLifecycle(user) {
  exactKeys(user, ['id', 'role', 'plan', 'deletionStatus', 'deletedAt', 'tokenVersion'])
  representIdentityValue(user.id, 'int', false)
  check(BigInt(user.id) > 0n, 'identity_user_id_invalid')
  const issues = []
  if (!['user', 'admin'].includes(user.role)) issues.push('identity_role_unknown')
  if (!['free', 'plus', 'pro'].includes(user.plan)) issues.push('identity_plan_unknown')
  if (!['active', 'anonymized'].includes(user.deletionStatus)) issues.push('identity_lifecycle_unknown')
  try {
    representIdentityValue(user.tokenVersion, 'int', false)
    if (BigInt(user.tokenVersion) < 0n) issues.push('identity_token_version_invalid')
  } catch { issues.push('identity_token_version_invalid') }
  try { inspectWallClock(user.deletedAt) } catch { issues.push('identity_deleted_time_invalid') }
  if (user.deletionStatus === 'active' && user.deletedAt !== null) issues.push('identity_active_with_deleted_time')
  if (user.deletionStatus === 'anonymized' && user.deletedAt === null) issues.push('identity_anonymized_without_deleted_time')
  if (user.deletionStatus === 'anonymized' && (user.role !== 'user' || user.plan !== 'free')) issues.push('identity_anonymized_privilege_conflict')
  return { userId: user.id, issues, stateConsistent: issues.length === 0,
    candidate: issues.length ? null : { role: user.role, plan: user.plan, deletionStatus: user.deletionStatus, tokenVersion: user.tokenVersion },
    sourceLoginEligible: issues.length === 0 && user.deletionStatus === 'active' && user.deletedAt === null,
    // Source eligibility is diagnostic; no V4 session, grant or activation is produced.
    readyForBackfill: false }
}
