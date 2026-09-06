export type MembershipPlan = 'free' | 'plus' | 'pro'
export interface MembershipState {
  userId: number
  planCode: MembershipPlan
  billingPeriodCode: string | null
  sourceCode: string | null
  expirationKind: 'no_expiry' | 'at_time'
  expiresAtUtc: string | null
  revision: string
}

export function validateMembershipState(state: MembershipState): void {
  if (!Number.isSafeInteger(state.userId) || state.userId <= 0 || state.userId > 2147483647
    || !['free', 'plus', 'pro'].includes(state.planCode)
    || typeof state.revision !== 'string' || !/^[1-9]\d{0,19}$/.test(state.revision)
    || BigInt(state.revision) > 18446744073709551615n
    || ![state.billingPeriodCode, state.sourceCode].every(value => value === null || (typeof value === 'string' && [...value].length <= 20))) {
    throw new Error('membership_state_invalid')
  }
  if (state.expirationKind === 'no_expiry' && state.expiresAtUtc === null) return
  if (state.expirationKind !== 'at_time' || typeof state.expiresAtUtc !== 'string'
    || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(state.expiresAtUtc)) throw new Error('membership_expiry_invalid')
  const expiry = new Date(state.expiresAtUtc)
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== state.expiresAtUtc) throw new Error('membership_expiry_invalid')
}

// Evaluates current membership only. Authentication, deletion, administrator
// privileges, purchases and connection grants remain separate facts.
export function evaluateMembership(state: MembershipState, observedAt: Date) {
  validateMembershipState(state)
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) throw new Error('membership_clock_invalid')
  const expired = state.expiresAtUtc !== null && Date.parse(state.expiresAtUtc) <= observedAt.getTime()
  return { userId: state.userId, storedPlan: state.planCode, effectivePlan: expired ? 'free' as const : state.planCode,
    expired, expiresAtUtc: state.expiresAtUtc, revision: state.revision, observedAtUtc: observedAt.toISOString() }
}
