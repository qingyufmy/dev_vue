const POSITION_GUARD_FEATURE_ENV = 'POSITION_GUARD_FEATURE_ENABLED'
const POSITION_GUARD_FEATURE_DISABLED_ERROR = 'position_guard_feature_disabled'

/**
 * Deployment-level PivotGuard gate.
 *
 * Keep this lookup dynamic: tests and long-lived processes can change the
 * environment between calls, while only the literal value "true" enables the
 * feature.  The database global control remains the second, operational gate
 * and is evaluated only after this deployment gate has passed.
 */
export function isPositionGuardFeatureEnabled(environment = process.env) {
  return String(environment?.[POSITION_GUARD_FEATURE_ENV] ?? '').trim().toLowerCase() === 'true'
}

export function positionGuardFeatureDisabledResponse(res) {
  return res.status(404).json({ ok:false, error:POSITION_GUARD_FEATURE_DISABLED_ERROR })
}

export function positionGuardFeatureGate(_req, res, next) {
  if (!isPositionGuardFeatureEnabled()) return positionGuardFeatureDisabledResponse(res)
  return next()
}
