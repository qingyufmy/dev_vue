// Fixed Chan history-window policy for the production v7 calculation path.
//
// The policy is deliberately small and immutable.  Strategy-visible candle
// counts remain owned by the strategy tags; this module only describes the
// additional server-side history required by Chan structure calculations.

export const CHAN_WINDOW_POLICY_VERSION = 'chan_window_v7'
export const CHAN_WINDOW_POLICY_ID = 'dao_xau_v1'

export const CHAN_WINDOW_POLICIES = Object.freeze({
  [CHAN_WINDOW_POLICY_ID]: Object.freeze({
    M5: Object.freeze({ target: 1800, validators: Object.freeze([1400, 1600, 1800]) }),
    M15: Object.freeze({ target: 2000, validators: Object.freeze([1600, 1800, 2000]) }),
    H1: Object.freeze({ target: 1800, validators: Object.freeze([1400, 1600, 1800]) }),
    H4: Object.freeze({ target: 1000, validators: Object.freeze([600, 800, 1000]) }),
  }),
})

function normalizeTimeframe(timeframe) {
  return String(timeframe || '').trim().toUpperCase()
}

function freezePolicy(timeframe, policy, supported = true) {
  const target = supported ? Math.max(30, Math.trunc(Number(policy?.target) || 0)) : 0
  const rawValidators = Array.isArray(policy?.validators) ? policy.validators : []
  const validators = [...new Set(rawValidators.map(value => Math.trunc(Number(value)))
    .filter(value => value >= 30 && value <= target))].sort((a, b) => a - b)
  if (supported && !validators.includes(target)) validators.push(target)
  return Object.freeze({
    timeframe,
    target,
    validators: Object.freeze(validators),
    maximumHistoryCount: target,
    validationWindowCounts: Object.freeze(validators),
    windowPolicyVersion: CHAN_WINDOW_POLICY_VERSION,
    policyId: CHAN_WINDOW_POLICY_ID,
    supported,
  })
}

export function getChanWindowPolicy(timeframe, policyId = CHAN_WINDOW_POLICY_ID) {
  const tf = normalizeTimeframe(timeframe)
  const configured = CHAN_WINDOW_POLICIES[policyId]?.[tf]
  if (configured) return freezePolicy(tf, configured)
  // Non-configured periods are explicitly unsupported by this policy. Callers can
  // retain their legacy v5 path or fail closed; they never silently inherit
  // one of the configured period windows.
  return Object.freeze({
    timeframe: tf || 'M30',
    target: 0,
    validators: Object.freeze([]),
    maximumHistoryCount: 0,
    validationWindowCounts: Object.freeze([]),
    windowPolicyVersion: 'unsupported',
    policyId: CHAN_WINDOW_POLICY_ID,
    supported: false,
    reason: 'unsupported_timeframe_policy',
  })
}

export function resolveChanWindowPolicy(timeframe, options = {}) {
  if (options?.windowPolicy && typeof options.windowPolicy === 'object') {
    const policy = options.windowPolicy
    return freezePolicy(normalizeTimeframe(timeframe) || policy.timeframe || 'M30', policy)
  }
  return getChanWindowPolicy(timeframe, options?.policyId || CHAN_WINDOW_POLICY_ID)
}

export function chanHistoryTarget(timeframe, options = {}) {
  return resolveChanWindowPolicy(timeframe, options).target
}

export function chanValidationWindows(timeframe, options = {}) {
  return [...resolveChanWindowPolicy(timeframe, options).validators]
}

export function isChanWindowPolicyVersion(value) {
  return String(value || '').trim() === CHAN_WINDOW_POLICY_VERSION
}

export const __chanWindowPolicyTest = {
  normalizeTimeframe,
  freezePolicy,
}
