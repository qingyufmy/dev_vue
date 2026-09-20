import { RiskError, riskPolicyHash, type AccountRiskSummary, type EffectiveRiskPolicy, type RiskEvaluationResult, type RiskQuoteSnapshot } from './risk.js'
import type { RiskAction } from './risk-action.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

export interface PositionProtectionRiskTarget {
  readonly terminalInstanceId: string
  readonly brokerServer: string
  readonly login: string
  readonly ticket: string
  readonly positionIdentifier: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
}
export interface PositionProtectionRiskRequest {
  readonly workflowId: string
  readonly workflowRevision: number
  readonly userId: number
  readonly accountId: string
  readonly target: PositionProtectionRiskTarget
  readonly remainingVolume: string
  readonly minimumPositionRevision: number
  readonly notBefore: number
  readonly expiresAt: number
  readonly protection: { readonly stopLoss?: string; readonly takeProfit?: string }
}
export interface PositionProtectionRiskContext {
  readonly userId: number
  readonly accountId: string
  readonly authorized: boolean
  readonly connectionPaused: boolean
  readonly tradePermission: boolean
  readonly accountObservedAt: string
  readonly collectionComplete: boolean
  readonly policy: EffectiveRiskPolicy
  readonly summary: AccountRiskSummary
  readonly quote: RiskQuoteSnapshot
  readonly instrument: { readonly symbol: string; readonly point: string; readonly tickSize: string; readonly tradeEnabled: boolean; readonly revision: number; readonly observedAt: string; readonly maxAgeMs: number }
  readonly position: PositionProtectionRiskTarget & {
    readonly volume: string; readonly stopLoss: string | null; readonly takeProfit: string | null; readonly revision: number; readonly observedAt: string
  }
  readonly revisions: { readonly account: number; readonly positions: number; readonly quote: number; readonly contract: number; readonly risk: number }
}
export interface PositionProtectionRiskReview {
  readonly workflowId: string
  readonly workflowRevision: number
  readonly requestHash: string
  readonly contextHash: string
  readonly evaluation: RiskEvaluationResult
}
const scale = 10n ** 18n
const identityKeys = ['terminalInstanceId','brokerServer','login','ticket','positionIdentifier','symbol','side'] as const
const uint64 = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
function units(value: unknown, zero = false): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value)) return null
  const [whole,fraction=''] = value.split('.')
  const amount = BigInt(whole!) * scale + BigInt(fraction.padEnd(18,'0'))
  return amount > 0n || zero ? amount : null
}
const time = (value: number) => Number.isSafeInteger(value) && value >= 0
const fresh = (value: string, now: number, seconds: number) => {
  const at = Date.parse(value)
  return Number.isSafeInteger(at) && new Date(at).toISOString() === value && at <= now && now - at <= seconds * 1000
}

/** No AI lineage or terminal effects. A caller must persist this review with a uniquely linked child intent in its own transaction. */
export function evaluatePositionProtection(request: PositionProtectionRiskRequest, context: PositionProtectionRiskContext, now = new Date()): PositionProtectionRiskReview {
  const at = now.getTime(), policy = context.policy, position = context.position, revisions = context.revisions
  if (!time(at) || !time(request.notBefore) || !time(request.expiresAt) || request.notBefore >= request.expiresAt
    || !Number.isSafeInteger(request.workflowRevision) || request.workflowRevision < 2
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.workflowId)
    || !Number.isSafeInteger(request.userId) || request.userId < 1 || request.userId > 2147483647 || !uint64(request.accountId)
    || !request.target || !text(request.target.terminalInstanceId) || !text(request.target.brokerServer)
    || !text(request.target.login) || request.target.login.length > 64
    || !uint64(request.target.ticket) || !uint64(request.target.positionIdentifier)
    || !/^[A-Za-z0-9._-]{1,64}$/.test(request.target.symbol) || !['buy','sell'].includes(request.target.side)
    || !Number.isSafeInteger(request.minimumPositionRevision) || request.minimumPositionRevision < 1
    || units(request.remainingVolume) === null || !request.protection || Array.isArray(request.protection)
    || Object.keys(request.protection).length === 0 || Object.keys(request.protection).some(key => !['stopLoss','takeProfit'].includes(key))
    || Object.values(request.protection).some(price => units(price) === null)) throw new RiskError('position_protection_request_invalid',422)
  const actionId = `protection:${request.workflowId}:${request.workflowRevision}`
  const review = (code: string | null, action?: RiskAction): PositionProtectionRiskReview => ({
    workflowId: request.workflowId, workflowRevision: request.workflowRevision, requestHash: sha256Canonical(request), contextHash: sha256Canonical(context),
    evaluation: { status: code ? 'rejected' : 'approved', rejectCode: code,
      rules: [{code: code ?? 'RISK_POSITION_PROTECTION_APPROVED',outcome: code ? 'rejected' : 'passed',actionId,
        details:{workflow_id:request.workflowId,workflow_revision:request.workflowRevision,positions_revision:revisions.positions}}],
      approvedActions: action ? [action] : [], evaluatedAt: now.toISOString(), policyHash: riskPolicyHash(policy), manualReleaseId:null,manualReleaseRevision:null },
  })
  if (context.userId !== request.userId || context.accountId !== request.accountId || policy.userId !== request.userId
    || policy.accountId !== request.accountId || context.summary.userId !== request.userId || context.summary.accountId !== request.accountId) return review('RISK_ACCOUNT_SCOPE_MISMATCH')
  if (context.authorized !== true || context.connectionPaused !== false || context.tradePermission !== true) return review('RISK_PROTECTION_ACCESS_UNAVAILABLE')
  if (policy.globalKillSwitch) return review('RISK_GLOBAL_KILL_SWITCH')
  if (policy.values.accountKillSwitch) return review('RISK_ACCOUNT_KILL_SWITCH')
  if (at >= request.expiresAt || at < request.notBefore) return review('RISK_PROTECTION_REQUEST_EXPIRED')
  if (!context.collectionComplete || !context.summary.dataComplete || context.summary.incompleteReasons.length !== 0) return review('RISK_DATA_INCOMPLETE')
  if (Object.values(revisions).some(value => !Number.isSafeInteger(value) || value < 1)
    || context.summary.revision !== revisions.risk || context.quote.revision !== revisions.quote || context.instrument.revision !== revisions.contract
    || position.revision !== revisions.positions || position.revision < request.minimumPositionRevision) return review('RISK_EXPECTED_STATE_STALE')
  if (identityKeys.some(key => position[key] !== request.target[key])) return review('RISK_PROTECTION_TARGET_MISMATCH')
  if (units(position.volume) === null || units(position.volume) !== units(request.remainingVolume)) return review('RISK_PROTECTION_VOLUME_CHANGED')
  if (!fresh(position.observedAt,at,policy.values.maxRiskSummaryAgeSeconds) || Date.parse(position.observedAt) < request.notBefore) return review('RISK_POSITION_STALE')
  if (!fresh(context.accountObservedAt,at,policy.values.maxRiskSummaryAgeSeconds)) return review('RISK_ACCOUNT_STALE')
  if (!Number.isSafeInteger(context.instrument.maxAgeMs) || context.instrument.maxAgeMs < 1 || context.instrument.maxAgeMs > 300000
    || !fresh(context.instrument.observedAt,at,context.instrument.maxAgeMs/1000)) return review('RISK_INSTRUMENT_STALE')
  if (!fresh(context.summary.observedAt,at,policy.values.maxRiskSummaryAgeSeconds)) return review('RISK_SUMMARY_STALE')
  if (!fresh(context.quote.observedAt,at,policy.values.maxQuoteAgeSeconds)) return review('RISK_QUOTE_STALE')
  if (context.summary.clockStatus !== 'calibrated' || !Number.isInteger(context.summary.terminalTimezoneOffsetMinutes)
    || context.summary.terminalTimezoneOffsetMinutes! < -840 || context.summary.terminalTimezoneOffsetMinutes! > 840) return review('RISK_TERMINAL_CLOCK_UNVERIFIED')
  if (context.quote.symbol !== request.target.symbol || context.instrument.symbol !== request.target.symbol) return review('RISK_PROTECTION_SYMBOL_MISMATCH')
  if (!context.instrument.tradeEnabled) return review('RISK_INSTRUMENT_TRADE_DISABLED')
  const allowed = policy.values.allowedSymbols.map(symbol => symbol.toUpperCase())
  if (!allowed.includes('*') && !allowed.includes(request.target.symbol.toUpperCase())) return review('RISK_SYMBOL_NOT_ALLOWED')
  const bid = units(context.quote.bid), ask = units(context.quote.ask), point = units(context.instrument.point), tick = units(context.instrument.tickSize)
  const spreadLimit = units(String(policy.values.maxSpreadPoints),true)
  if (bid === null || ask === null || ask < bid || point === null || tick === null || spreadLimit === null) return review('RISK_CALCULATION_DATA_INVALID')
  if ((ask-bid)*scale > spreadLimit*point) return review('RISK_SPREAD_LIMIT')
  if ((position.stopLoss !== null && units(position.stopLoss) === null) || (position.takeProfit !== null && units(position.takeProfit) === null)) return review('RISK_POSITION_PROTECTION_DATA_INVALID')
  const side = position.side
  if (side !== 'buy' && side !== 'sell') return review('RISK_ACTION_SIDE_INVALID')
  for (const [key,price] of Object.entries(request.protection)) {
    const amount = units(price)!
    if (amount % tick !== 0n) return review('RISK_PROTECTION_PRICE_OFF_TICK')
    if (key === 'stopLoss') {
      if (side === 'buy' ? amount >= bid : amount <= ask) return review('RISK_STOP_LOSS_DIRECTION_INVALID')
      const old = units(position.stopLoss)
      if (old !== null && (side === 'buy' ? amount < old : amount > old)) return review('RISK_PROTECTION_STOP_WIDENING')
    } else if (side === 'buy' ? amount <= bid : amount >= ask) return review('RISK_TAKE_PROFIT_DIRECTION_INVALID')
  }
  const parameters: RiskAction['parameters'] = {ticket:position.ticket}
  if (request.protection.stopLoss !== undefined) parameters.stop_loss = request.protection.stopLoss
  if (request.protection.takeProfit !== undefined) parameters.take_profit = request.protection.takeProfit
  return review(null,{actionId,kind:'modify_position',parameters,expectedState:{accountRevision:revisions.account,positionsRevision:revisions.positions,
    quoteRevision:revisions.quote,contractRevision:revisions.contract,riskRevision:revisions.risk}})
}
