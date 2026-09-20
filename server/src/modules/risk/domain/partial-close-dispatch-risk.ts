import type { PositionProtectionRiskContext, PositionProtectionRiskTarget } from './position-protection-risk.js'
import { explicitPartialVolume, PartialCloseError } from './partial-close-actions.js'
import { RiskError, riskPolicyHash } from './risk.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

export interface PartialCloseDispatchRiskRequest {
  workflowId: string; userId: number; accountId: string; target: PositionProtectionRiskTarget
  initialVolume: string; closeVolume: string; positionRevision: number; notBefore: number; expiresAt: number
}
export type PartialCloseDispatchRiskContext = PositionProtectionRiskContext & {
  instrument: PositionProtectionRiskContext['instrument'] & { volumeMin: string; volumeMax: string; volumeStep: string }
}
const keys = ['terminalInstanceId','brokerServer','login','ticket','positionIdentifier','symbol','side'] as const
const uint64 = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
const fresh = (value: string, at: number, maxAge: number) => {
  const time = Date.parse(value)
  return Number.isSafeInteger(time) && Number.isSafeInteger(maxAge) && maxAge > 0 && time <= at && at - time <= maxAge
}

/** Admission for a frozen close-with-continuation; never approves or executes the later protection action. */
export function evaluatePartialCloseDispatch(request: PartialCloseDispatchRiskRequest, context: PartialCloseDispatchRiskContext, now = new Date()) {
  const at = now.getTime(), { policy, summary, position, revisions, instrument } = context
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(request.notBefore) || !Number.isSafeInteger(request.expiresAt)
    || request.notBefore < 0 || request.notBefore >= request.expiresAt || !Number.isSafeInteger(request.positionRevision) || request.positionRevision < 1
    || !Number.isSafeInteger(request.userId) || request.userId < 1 || request.userId > 2147483647 || !uint64(request.accountId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.workflowId)
    || !request.target || typeof request.target.login !== 'string' || !request.target.login.trim() || request.target.login.length > 64
    || /[\u0000-\u001f\u007f]/.test(request.target.login) || !uint64(request.target.ticket) || !uint64(request.target.positionIdentifier)
    || !['buy','sell'].includes(request.target.side) || !/^[A-Za-z0-9._-]{1,64}$/.test(request.target.symbol)
    || [request.target.terminalInstanceId,request.target.brokerServer].some(value => typeof value !== 'string' || !value.trim() || value.length > 128)) {
    throw new RiskError('partial_close_dispatch_request_invalid',422)
  }
  const review = (rejectCode: string | null, sized?: { volume: string; remainingVolume: string }) => ({
    status: rejectCode === null ? 'approved' as const : 'rejected' as const, rejectCode,
    requestHash: sha256Canonical(request), contextHash: sha256Canonical(context), policyHash: riskPolicyHash(policy),
    evaluatedAt: now.toISOString(), volume: sized?.volume ?? null, remainingVolume: sized?.remainingVolume ?? null,
  })
  if ([context,policy,summary].some(value => value.userId !== request.userId || value.accountId !== request.accountId)) return review('RISK_ACCOUNT_SCOPE_MISMATCH')
  if (context.authorized !== true || context.connectionPaused !== false || context.tradePermission !== true) return review('RISK_PARTIAL_CLOSE_ACCESS_UNAVAILABLE')
  if (policy.globalKillSwitch) return review('RISK_GLOBAL_KILL_SWITCH')
  if (policy.values.accountKillSwitch) return review('RISK_ACCOUNT_KILL_SWITCH')
  if (at < request.notBefore || at >= request.expiresAt) return review('RISK_PARTIAL_CLOSE_REQUEST_EXPIRED')
  if (!context.collectionComplete || !summary.dataComplete || summary.incompleteReasons.length !== 0) return review('RISK_DATA_INCOMPLETE')
  if (Object.values(revisions).some(value => !Number.isSafeInteger(value) || value < 1)
    || summary.revision !== revisions.risk || position.revision !== revisions.positions || position.revision !== request.positionRevision
    || context.quote.revision !== revisions.quote || instrument.revision !== revisions.contract) return review('RISK_EXPECTED_STATE_STALE')
  if (keys.some(key => position[key] !== request.target[key])) return review('RISK_PARTIAL_CLOSE_TARGET_MISMATCH')
  const maxAge = policy.values.maxRiskSummaryAgeSeconds * 1000
  if (!fresh(context.accountObservedAt,at,maxAge) || !fresh(summary.observedAt,at,maxAge) || !fresh(position.observedAt,at,maxAge)) return review('RISK_PARTIAL_CLOSE_FACTS_STALE')
  if (!fresh(context.quote.observedAt,at,policy.values.maxQuoteAgeSeconds * 1000)) return review('RISK_QUOTE_STALE')
  if (instrument.maxAgeMs > 300000 || !fresh(instrument.observedAt,at,instrument.maxAgeMs)) return review('RISK_INSTRUMENT_STALE')
  if (summary.clockStatus !== 'calibrated' || !Number.isInteger(summary.terminalTimezoneOffsetMinutes)
    || summary.terminalTimezoneOffsetMinutes! < -840 || summary.terminalTimezoneOffsetMinutes! > 840) return review('RISK_TERMINAL_CLOCK_UNVERIFIED')
  if (instrument.symbol !== request.target.symbol || context.quote.symbol !== request.target.symbol) return review('RISK_PARTIAL_CLOSE_SYMBOL_MISMATCH')
  if (!instrument.tradeEnabled) return review('RISK_INSTRUMENT_TRADE_DISABLED')
  try {
    const frozen = explicitPartialVolume(request.initialVolume,request.closeVolume,instrument)
    const current = explicitPartialVolume(position.volume,request.closeVolume,instrument)
    if (frozen.remainingVolume !== current.remainingVolume) return review('RISK_PARTIAL_CLOSE_VOLUME_CHANGED')
    return review(null,current)
  } catch (error) {
    if (error instanceof PartialCloseError) return review('RISK_PARTIAL_CLOSE_LIMITS_INVALID')
    throw error
  }
}
