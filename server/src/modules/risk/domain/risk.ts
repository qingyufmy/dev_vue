import { createHash } from 'node:crypto'
import type { JsonObject, TraderAction, TraderDecisionResult } from '../../inference/domain/inference.js'

export type RiskDecisionStatus = 'approved' | 'rejected'
export type RiskRuleOutcome = 'passed' | 'rejected' | 'not_applicable'

export interface RiskPolicyValues {
  allowedSymbols: string[]
  requireStopLoss: true
  failClosedOnIncompleteData: true
  maxRiskPerTradePercent: number
  maxDailyLossPercent: number
  maxDrawdownPercent: number
  maxOpenPositions: number
  maxPendingOrders: number
  maxTotalVolume: number
  maxSpreadPoints: number
  maxQuoteAgeSeconds: number
  maxRiskSummaryAgeSeconds: number
  maxDecisionAgeSeconds: number
  maxPriceDeviationPercent: number
  minOpenIntervalSeconds: number
  maxDailyOpenCount: number
  consecutiveLossLimit: number
  lossCooldownMinutes: number
  pendingValidMinutes: number
  weekendCloseMinutes: number
  tradeSendEnabled: boolean
  accountKillSwitch: boolean
}

export type AccountRiskPolicyPatch = Partial<Pick<RiskPolicyValues,
  'maxRiskPerTradePercent' | 'maxDailyLossPercent' | 'maxDrawdownPercent' |
  'maxOpenPositions' | 'maxPendingOrders' | 'maxTotalVolume' | 'maxSpreadPoints' |
  'minOpenIntervalSeconds' | 'maxDailyOpenCount' | 'consecutiveLossLimit' |
  'lossCooldownMinutes' | 'pendingValidMinutes' | 'weekendCloseMinutes' |
  'tradeSendEnabled' | 'accountKillSwitch'>>

export interface RiskPolicyBoundary {
  values: Omit<RiskPolicyValues, 'tradeSendEnabled' | 'accountKillSwitch'>
  globalKillSwitch: boolean
  revision: number
}

export interface EffectiveRiskPolicy {
  accountId: string
  userId: number
  platformPolicyVersionId: string
  accountPolicyVersionId: string | null
  policySetRevision: number
  globalKillSwitch: boolean
  values: RiskPolicyValues
  editableFields: Array<keyof AccountRiskPolicyPatch>
  updatedAt: string
}

export interface AccountRiskSummary {
  accountId: string
  userId: number
  businessDate: string | null
  equity: string
  freeMargin: string
  marginLevelPercent: number | null
  dailyLossPercent: number
  drawdownPercent: number
  openPositions: number
  pendingOrders: number
  totalVolume: string
  dailyOpenCount: number
  consecutiveLosses: number
  terminalTimezoneOffsetMinutes: number | null
  clockStatus: 'calibrated' | 'observer_bootstrap' | 'stale' | 'unavailable'
  lastSuccessfulOpenAt: string | null
  cooldownUntil: string | null
  dataComplete: boolean
  incompleteReasons: string[]
  observedAt: string
  revision: number
}

export interface RiskInstrumentSnapshot {
  symbol: string
  point: string
  tickSize: string
  tickValue: string
  volumeMin: string
  volumeMax: string
  volumeStep: string
  tradeEnabled: boolean
  revision: number
}

export interface RiskQuoteSnapshot {
  symbol: string
  bid: string
  ask: string
  observedAt: string
  revision: number
}

export interface RiskRuleResult {
  code: string
  outcome: RiskRuleOutcome
  actionId: string | null
  details: JsonObject
}

export interface RiskEvaluationInput {
  decisionId: string
  decisionRevision: number
  decisionCreatedAt: string
  decisionStatus: 'proposed'
  result: TraderDecisionResult
  policy: EffectiveRiskPolicy
  summary: AccountRiskSummary
  quote: RiskQuoteSnapshot
  instrument: RiskInstrumentSnapshot
  positions: JsonObject[]
  pendingOrders: JsonObject[]
  currentRevisions: {
    analysis: number
    subscription: number
    account: number
    positions: number
    pendingOrders: number
    quote: number
    contract: number
    risk: number
  }
}

export interface RiskEvaluationResult {
  status: RiskDecisionStatus
  rejectCode: string | null
  rules: RiskRuleResult[]
  approvedActions: TraderAction[]
  evaluatedAt: string
  policyHash: string
}

export class RiskError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code) }
}

export const DEFAULT_RISK_POLICY: Readonly<RiskPolicyValues> = Object.freeze({
  allowedSymbols: ['*'], requireStopLoss: true, failClosedOnIncompleteData: true,
  maxRiskPerTradePercent: 1, maxDailyLossPercent: 3, maxDrawdownPercent: 8,
  maxOpenPositions: 10, maxPendingOrders: 20, maxTotalVolume: 1, maxSpreadPoints: 120,
  maxQuoteAgeSeconds: 15, maxRiskSummaryAgeSeconds: 30, maxDecisionAgeSeconds: 300, maxPriceDeviationPercent: 0.1,
  minOpenIntervalSeconds: 30, maxDailyOpenCount: 20, consecutiveLossLimit: 3,
  lossCooldownMinutes: 60, pendingValidMinutes: 180, weekendCloseMinutes: 60,
  tradeSendEnabled: false, accountKillSwitch: false,
})

export const ACCOUNT_EDITABLE_FIELDS: Array<keyof AccountRiskPolicyPatch> = [
  'maxRiskPerTradePercent', 'maxDailyLossPercent', 'maxDrawdownPercent', 'maxOpenPositions',
  'maxPendingOrders', 'maxTotalVolume', 'maxSpreadPoints', 'minOpenIntervalSeconds',
  'maxDailyOpenCount', 'consecutiveLossLimit', 'lossCooldownMinutes', 'pendingValidMinutes',
  'weekendCloseMinutes', 'tradeSendEnabled', 'accountKillSwitch',
]

const lowerIsSafer = new Set<keyof AccountRiskPolicyPatch>([
  'maxRiskPerTradePercent', 'maxDailyLossPercent', 'maxDrawdownPercent', 'maxOpenPositions',
  'maxPendingOrders', 'maxTotalVolume', 'maxSpreadPoints', 'maxDailyOpenCount',
  'consecutiveLossLimit', 'pendingValidMinutes',
])
const higherIsSafer = new Set<keyof AccountRiskPolicyPatch>(['minOpenIntervalSeconds', 'lossCooldownMinutes', 'weekendCloseMinutes'])

export function resolveRiskPolicy(input: {
  accountId: string
  userId: number
  platformPolicyVersionId: string
  accountPolicyVersionId: string | null
  policySetRevision: number
  platform: RiskPolicyBoundary
  account: AccountRiskPolicyPatch | null
  updatedAt: string
}): EffectiveRiskPolicy {
  const platform = assertPolicyValues({ ...input.platform.values, tradeSendEnabled: false, accountKillSwitch: false })
  const values: RiskPolicyValues = { ...platform, allowedSymbols: [...platform.allowedSymbols] }
  for (const key of ACCOUNT_EDITABLE_FIELDS) {
    const candidate = input.account?.[key]
    if (candidate === undefined) continue
    if (typeof values[key] === 'boolean') {
      ;(values[key] as boolean) = Boolean(candidate)
      continue
    }
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new RiskError(`risk_policy_${String(key)}_invalid`, 422)
    const boundary = platform[key]
    if (typeof boundary !== 'number') throw new RiskError(`risk_policy_${String(key)}_invalid`, 422)
    if (lowerIsSafer.has(key) && candidate > boundary) throw new RiskError(`risk_policy_${String(key)}_relaxation_forbidden`, 422)
    if (higherIsSafer.has(key) && candidate < boundary) throw new RiskError(`risk_policy_${String(key)}_relaxation_forbidden`, 422)
    ;(values[key] as number) = candidate
  }
  values.requireStopLoss = true
  values.failClosedOnIncompleteData = true
  return {
    accountId: input.accountId, userId: input.userId, platformPolicyVersionId: input.platformPolicyVersionId,
    accountPolicyVersionId: input.accountPolicyVersionId, policySetRevision: input.policySetRevision,
    globalKillSwitch: input.platform.globalKillSwitch,
    values, editableFields: [...ACCOUNT_EDITABLE_FIELDS], updatedAt: input.updatedAt,
  }
}

export function assertAccountPolicyPatch(value: AccountRiskPolicyPatch) {
  if (Object.keys(value).length === 0) throw new RiskError('risk_policy_changes_required', 422)
  const unknown = Object.keys(value).filter(key => !ACCOUNT_EDITABLE_FIELDS.includes(key as keyof AccountRiskPolicyPatch))
  if (unknown.length) throw new RiskError('risk_policy_field_unknown', 422)
  for (const [key, candidate] of Object.entries(value)) {
    if (key === 'tradeSendEnabled' || key === 'accountKillSwitch') {
      if (typeof candidate !== 'boolean') throw new RiskError(`risk_policy_${key}_invalid`, 422)
      continue
    }
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) throw new RiskError(`risk_policy_${key}_invalid`, 422)
    if (['maxOpenPositions', 'maxPendingOrders', 'minOpenIntervalSeconds', 'maxDailyOpenCount', 'consecutiveLossLimit',
      'lossCooldownMinutes', 'pendingValidMinutes', 'weekendCloseMinutes'].includes(key) && !Number.isSafeInteger(candidate)) throw new RiskError(`risk_policy_${key}_invalid`, 422)
    if (key === 'pendingValidMinutes' && candidate < 1) throw new RiskError(`risk_policy_${key}_invalid`, 422)
  }
}

export function buildAccountRiskSummary(input: Omit<AccountRiskSummary, 'marginLevelPercent' | 'incompleteReasons'> & { incompleteReasons?: string[]; margin: string }): AccountRiskSummary {
  const equity = decimal(input.equity, 'risk_summary_equity_invalid')
  const margin = decimal(input.margin, 'risk_summary_margin_invalid')
  decimal(input.freeMargin, 'risk_summary_free_margin_invalid')
  decimal(input.totalVolume, 'risk_summary_total_volume_invalid')
  const reasons = [...new Set((input.incompleteReasons ?? []).map(value => value.trim()).filter(Boolean))].sort()
  if (!['calibrated', 'observer_bootstrap', 'stale', 'unavailable'].includes(input.clockStatus)) throw new RiskError('risk_summary_clock_status_invalid', 422)
  if (input.terminalTimezoneOffsetMinutes !== null && (!Number.isInteger(input.terminalTimezoneOffsetMinutes) || input.terminalTimezoneOffsetMinutes < -840 || input.terminalTimezoneOffsetMinutes > 840)) throw new RiskError('risk_summary_timezone_invalid', 422)
  if ((input.clockStatus !== 'calibrated' || input.terminalTimezoneOffsetMinutes === null) && !reasons.includes('terminal_clock_unverified')) reasons.push('terminal_clock_unverified')
  const metrics = [input.dailyLossPercent, input.drawdownPercent]
  if (metrics.some(value => !Number.isFinite(value) || value < 0)) throw new RiskError('risk_summary_metric_invalid', 422)
  for (const value of [input.openPositions, input.pendingOrders, input.dailyOpenCount, input.consecutiveLosses]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RiskError('risk_summary_count_invalid', 422)
  }
  if (input.dataComplete && reasons.length) throw new RiskError('risk_summary_completeness_conflict', 422)
  return {
    accountId: input.accountId, userId: input.userId, businessDate: input.businessDate,
    equity: input.equity, freeMargin: input.freeMargin,
    marginLevelPercent: margin > 0 ? Number((equity / margin * 100).toFixed(4)) : null,
    dailyLossPercent: input.dailyLossPercent, drawdownPercent: input.drawdownPercent,
    openPositions: input.openPositions, pendingOrders: input.pendingOrders, totalVolume: input.totalVolume,
    dailyOpenCount: input.dailyOpenCount, consecutiveLosses: input.consecutiveLosses,
    terminalTimezoneOffsetMinutes: input.terminalTimezoneOffsetMinutes, clockStatus: input.clockStatus,
    lastSuccessfulOpenAt: input.lastSuccessfulOpenAt, cooldownUntil: input.cooldownUntil,
    dataComplete: input.dataComplete, incompleteReasons: reasons, observedAt: input.observedAt, revision: input.revision,
  }
}

export function evaluateRisk(input: RiskEvaluationInput, now = new Date()): RiskEvaluationResult {
  const rules: RiskRuleResult[] = []
  const policy = input.policy.values
  const riskReducing = input.result.actions.filter(action => isRiskReducing(action, input))
  const riskIncreasing = input.result.actions.filter(action => !isRiskReducing(action, input))
  const reject = (code: string, actionId: string | null = null, details: JsonObject = {}): RiskEvaluationResult => {
    rules.push({ code, outcome: 'rejected', actionId, details })
    return result('rejected', code, rules, [], input.policy, now)
  }
  const pass = (code: string, details: JsonObject = {}) => rules.push({ code, outcome: 'passed' as const, actionId: null, details })

  if (input.summary.accountId !== input.policy.accountId || input.summary.userId !== input.policy.userId) return reject('RISK_ACCOUNT_SCOPE_MISMATCH')
  if (input.summary.revision !== input.currentRevisions.risk) return reject('RISK_SUMMARY_REVISION_STALE')
  for (const action of input.result.actions) {
    const expected = expectedState(action)
    for (const [key, current] of Object.entries(input.currentRevisions)) {
      if (expected[`${key}Revision`] !== current) return reject('RISK_EXPECTED_STATE_STALE', action.actionId, { resource: key })
    }
  }
  pass('RISK_EXPECTED_STATE_CURRENT')

  if (input.result.action === 'hold') {
    pass('RISK_HOLD_NO_EXECUTION')
    return result('approved', null, rules, [], input.policy, now)
  }

  if (!policy.tradeSendEnabled) return reject('RISK_TRADE_SEND_DISABLED')

  for (const action of riskReducing) {
    const ticket = String(action.parameters.ticket ?? '')
    const inventory = action.kind === 'cancel_order' || action.kind === 'modify_order' ? input.pendingOrders : input.positions
    if (!inventory.some(item => String(item.ticket ?? '') === ticket)) return reject('RISK_TARGET_NOT_FOUND', action.actionId)
  }
  if (riskIncreasing.length === 0) {
    pass('RISK_REDUCING_ACTION_ALLOWED')
    return result('approved', null, rules, input.result.actions, input.policy, now)
  }

  if (input.policy.globalKillSwitch) return reject('RISK_GLOBAL_KILL_SWITCH')
  if (policy.accountKillSwitch) return reject('RISK_ACCOUNT_KILL_SWITCH')
  if (!input.summary.dataComplete) return reject('RISK_DATA_INCOMPLETE', null, { reasons: input.summary.incompleteReasons })
  const summaryAge = ageSeconds(input.summary.observedAt, now)
  if (summaryAge === null || summaryAge < -5) return reject('RISK_SUMMARY_TIME_INVALID')
  if (summaryAge > policy.maxRiskSummaryAgeSeconds) return reject('RISK_SUMMARY_STALE')
  if (input.summary.dailyLossPercent >= policy.maxDailyLossPercent) return reject('RISK_DAILY_LOSS_LIMIT')
  if (input.summary.drawdownPercent >= policy.maxDrawdownPercent) return reject('RISK_DRAWDOWN_LIMIT')
  if (input.summary.dailyOpenCount >= policy.maxDailyOpenCount) return reject('RISK_DAILY_OPEN_LIMIT')
  if (input.summary.consecutiveLosses >= policy.consecutiveLossLimit) return reject('RISK_CONSECUTIVE_LOSS_LIMIT')
  if (input.summary.cooldownUntil && Date.parse(input.summary.cooldownUntil) > now.getTime()) return reject('RISK_COOLDOWN_ACTIVE')
  if (input.summary.lastSuccessfulOpenAt && now.getTime() - Date.parse(input.summary.lastSuccessfulOpenAt) < policy.minOpenIntervalSeconds * 1000) return reject('RISK_MIN_OPEN_INTERVAL')
  if (input.summary.openPositions >= policy.maxOpenPositions && riskIncreasing.some(action => action.kind === 'market_order')) return reject('RISK_OPEN_POSITION_LIMIT')
  if (input.summary.pendingOrders >= policy.maxPendingOrders && riskIncreasing.some(action => action.kind === 'pending_order')) return reject('RISK_PENDING_ORDER_LIMIT')
  const decisionAge = ageSeconds(input.decisionCreatedAt, now)
  if (decisionAge === null || decisionAge < -5) return reject('RISK_DECISION_TIME_INVALID')
  if (decisionAge > policy.maxDecisionAgeSeconds) return reject('RISK_DECISION_EXPIRED')
  const quoteAge = ageSeconds(input.quote.observedAt, now)
  if (quoteAge === null || quoteAge < -5) return reject('RISK_QUOTE_TIME_INVALID')
  if (quoteAge > policy.maxQuoteAgeSeconds) return reject('RISK_QUOTE_STALE')
  if (input.summary.clockStatus !== 'calibrated' || input.summary.terminalTimezoneOffsetMinutes === null) return reject('RISK_TERMINAL_CLOCK_UNVERIFIED')
  if (weekendProtected(now, input.summary.terminalTimezoneOffsetMinutes, policy.weekendCloseMinutes)) return reject('RISK_WEEKEND_PROTECTION')
  if (!input.instrument.tradeEnabled) return reject('RISK_INSTRUMENT_TRADE_DISABLED')
  const allowed = policy.allowedSymbols.map(value => value.toUpperCase())
  if (!allowed.includes('*') && !allowed.includes(input.instrument.symbol.toUpperCase())) return reject('RISK_SYMBOL_NOT_ALLOWED')

  const bid = decimal(input.quote.bid, 'risk_quote_invalid')
  const ask = decimal(input.quote.ask, 'risk_quote_invalid')
  const point = decimal(input.instrument.point, 'risk_instrument_point_invalid')
  if (bid <= 0 || ask <= bid || point <= 0) return reject('RISK_QUOTE_INVALID')
  const spreadPoints = (ask - bid) / point
  if (spreadPoints > policy.maxSpreadPoints) return reject('RISK_SPREAD_LIMIT', null, { spread_points: Number(spreadPoints.toFixed(4)) })

  let addedVolume = 0
  for (const action of riskIncreasing) {
    const actionResult = evaluateAction(action, input, ask, bid)
    rules.push(...actionResult.rules)
    if (actionResult.rejectCode) return result('rejected', actionResult.rejectCode, rules, [], input.policy, now)
    addedVolume += actionResult.addedVolume
  }
  if (Number(input.summary.totalVolume) + addedVolume > policy.maxTotalVolume + 1e-9) return reject('RISK_TOTAL_VOLUME_LIMIT')
  pass('RISK_POLICY_APPROVED', { added_volume: Number(addedVolume.toFixed(8)) })
  return result('approved', null, rules, input.result.actions, input.policy, now)
}

function evaluateAction(action: TraderAction, input: RiskEvaluationInput, ask: number, bid: number) {
  const rules: RiskRuleResult[] = []
  const fail = (code: string, details: JsonObject = {}) => ({ rejectCode: code, addedVolume: 0, rules: [...rules, { code, outcome: 'rejected' as const, actionId: action.actionId, details }] })
  const pass = (code: string, details: JsonObject = {}) => rules.push({ code, outcome: 'passed' as const, actionId: action.actionId, details })
  if (action.kind === 'modify_position' || action.kind === 'modify_order') return fail('RISK_MODIFICATION_REQUIRES_DETERMINISTIC_DIFF')
  if (action.kind !== 'market_order' && action.kind !== 'pending_order') return { rejectCode: null, addedVolume: 0, rules }
  const params = action.parameters
  const side = String(params.side ?? (String(params.type ?? '').startsWith('buy') ? 'buy' : String(params.type ?? '').startsWith('sell') ? 'sell' : ''))
  if (side !== 'buy' && side !== 'sell') return fail('RISK_ACTION_SIDE_INVALID')
  const volume = decimal(params.volume, 'risk_action_volume_invalid')
  const stopLoss = decimal(params.stop_loss ?? params.sl, 'risk_action_stop_loss_invalid')
  const entry = action.kind === 'market_order' ? (side === 'buy' ? ask : bid) : decimal(params.price, 'risk_action_price_invalid')
  if (volume <= 0 || entry <= 0 || stopLoss <= 0) return fail('RISK_ACTION_NUMERIC_INVALID')
  if ((side === 'buy' && stopLoss >= entry) || (side === 'sell' && stopLoss <= entry)) return fail('RISK_STOP_LOSS_DIRECTION_INVALID')
  const volumeMin = decimal(input.instrument.volumeMin, 'risk_instrument_volume_invalid')
  const volumeMax = decimal(input.instrument.volumeMax, 'risk_instrument_volume_invalid')
  const volumeStep = decimal(input.instrument.volumeStep, 'risk_instrument_volume_invalid')
  if (volume < volumeMin || volume > volumeMax || !onGrid(volume, volumeMin, volumeStep)) return fail('RISK_VOLUME_BROKER_LIMIT')
  const tickSize = decimal(input.instrument.tickSize, 'risk_instrument_tick_invalid')
  const tickValue = decimal(input.instrument.tickValue, 'risk_instrument_tick_invalid')
  const equity = decimal(input.summary.equity, 'risk_summary_equity_invalid')
  if (tickSize <= 0 || tickValue <= 0 || equity <= 0) return fail('RISK_CALCULATION_DATA_INVALID')
  const riskAmount = Math.abs(entry - stopLoss) / tickSize * tickValue * volume
  const riskPercent = riskAmount / equity * 100
  if (riskPercent > input.policy.values.maxRiskPerTradePercent + 1e-9) return fail('RISK_PER_TRADE_LIMIT', { risk_percent: Number(riskPercent.toFixed(6)) })
  if (params.reference_price === undefined) return fail('RISK_REFERENCE_PRICE_REQUIRED')
  const reference = decimal(params.reference_price, 'risk_reference_price_invalid')
  if (reference <= 0) return fail('RISK_REFERENCE_PRICE_INVALID')
  if (Math.abs(entry - reference) / reference * 100 > input.policy.values.maxPriceDeviationPercent) return fail('RISK_PRICE_DEVIATION_LIMIT')
  pass('RISK_ACTION_APPROVED', { risk_percent: Number(riskPercent.toFixed(6)), volume })
  return { rejectCode: null, addedVolume: volume, rules }
}

function expectedState(action: TraderAction) {
  const value = action.expectedState
  return value as Record<string, unknown>
}

function isRiskReducing(action: TraderAction, input: RiskEvaluationInput) {
  if (action.kind === 'close_position' || action.kind === 'cancel_order') return true
  const ticket = String(action.parameters.ticket ?? '')
  if (action.kind === 'modify_position') {
    const position = input.positions.find(item => String(item.ticket ?? '') === ticket)
    if (!position) return false
    const side = String(position.side ?? '')
    const currentPrice = Number(position.currentPrice ?? position.current_price)
    const oldStop = Number(position.stopLoss ?? position.stop_loss ?? 0)
    const newStop = Number(action.parameters.stop_loss ?? action.parameters.sl)
    if (!(newStop > 0 && currentPrice > 0)) return false
    return side === 'buy' ? newStop < currentPrice && (oldStop <= 0 || newStop >= oldStop)
      : side === 'sell' ? newStop > currentPrice && (oldStop <= 0 || newStop <= oldStop) : false
  }
  if (action.kind === 'modify_order') {
    const order = input.pendingOrders.find(item => String(item.ticket ?? '') === ticket)
    if (!order) return false
    const type = String(order.type ?? '')
    const side = type.startsWith('buy') ? 'buy' : type.startsWith('sell') ? 'sell' : ''
    const oldEntry = Number(order.price)
    const oldStop = Number(order.stopLoss ?? order.stop_loss ?? 0)
    const oldVolume = Number(order.volume)
    const newEntry = Number(action.parameters.price ?? oldEntry)
    const newStop = Number(action.parameters.stop_loss ?? action.parameters.sl ?? oldStop)
    const newVolume = Number(action.parameters.volume ?? oldVolume)
    if (!(newEntry > 0 && newStop > 0 && newVolume > 0 && newVolume <= oldVolume)) return false
    if (side === 'buy') return newStop < newEntry && (oldStop <= 0 || newEntry - newStop <= oldEntry - oldStop)
    if (side === 'sell') return newStop > newEntry && (oldStop <= 0 || newStop - newEntry <= oldStop - oldEntry)
  }
  return false
}

function assertPolicyValues(value: RiskPolicyValues): RiskPolicyValues {
  if (value.requireStopLoss !== true || value.failClosedOnIncompleteData !== true) throw new RiskError('risk_platform_mandatory_rule_invalid', 500)
  if (!Array.isArray(value.allowedSymbols)) throw new RiskError('risk_allowed_symbols_invalid', 500)
  const allowedSymbols = [...new Set(value.allowedSymbols.map(symbol => typeof symbol === 'string' ? symbol.trim().toUpperCase() : '').filter(Boolean))]
  if (allowedSymbols.length === 0) throw new RiskError('risk_allowed_symbols_invalid', 500)
  const numeric = Object.entries(value).filter(([key]) => !['allowedSymbols', 'requireStopLoss', 'failClosedOnIncompleteData', 'tradeSendEnabled', 'accountKillSwitch'].includes(key))
  if (numeric.some(([, candidate]) => typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) throw new RiskError('risk_platform_numeric_rule_invalid', 500)
  if (![value.maxOpenPositions, value.maxPendingOrders, value.maxQuoteAgeSeconds, value.maxRiskSummaryAgeSeconds,
    value.maxDecisionAgeSeconds, value.minOpenIntervalSeconds, value.maxDailyOpenCount, value.consecutiveLossLimit,
    value.lossCooldownMinutes, value.pendingValidMinutes, value.weekendCloseMinutes].every(Number.isSafeInteger)) throw new RiskError('risk_platform_integer_rule_invalid', 500)
  if (value.maxQuoteAgeSeconds < 1 || value.maxRiskSummaryAgeSeconds < 1 || value.maxDecisionAgeSeconds < 1 || value.pendingValidMinutes < 1) throw new RiskError('risk_platform_duration_rule_invalid', 500)
  if (typeof value.tradeSendEnabled !== 'boolean' || typeof value.accountKillSwitch !== 'boolean') throw new RiskError('risk_platform_toggle_rule_invalid', 500)
  return { ...value, allowedSymbols }
}

function decimal(value: unknown, code: string) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new RiskError(code, 422)
  if (typeof value === 'string' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new RiskError(code, 422)
  const number = Number(value)
  if (!Number.isFinite(number)) throw new RiskError(code, 422)
  return number
}

function onGrid(value: number, minimum: number, step: number) {
  if (!(step > 0)) return false
  const units = (value - minimum) / step
  return Math.abs(units - Math.round(units)) < 1e-8
}

function ageSeconds(value: string, now: Date) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? (now.getTime() - timestamp) / 1000 : null
}

function weekendProtected(now: Date, offsetMinutes: number, advanceMinutes: number) {
  const terminal = new Date(now.getTime() + offsetMinutes * 60_000)
  const weekday = terminal.getUTCDay()
  if (weekday === 0 || weekday === 6) return true
  const minuteOfWeek = weekday * 1440 + terminal.getUTCHours() * 60 + terminal.getUTCMinutes()
  return minuteOfWeek >= 6 * 1440 - advanceMinutes
}

function result(status: RiskDecisionStatus, rejectCode: string | null, rules: RiskRuleResult[], approvedActions: TraderAction[], policy: EffectiveRiskPolicy, now: Date): RiskEvaluationResult {
  return { status, rejectCode, rules, approvedActions, evaluatedAt: now.toISOString(), policyHash: riskPolicyHash(policy) }
}

export function riskPolicyHash(policy: EffectiveRiskPolicy) {
  return hash({
    platformPolicyVersionId: policy.platformPolicyVersionId,
    accountPolicyVersionId: policy.accountPolicyVersionId,
    policySetRevision: policy.policySetRevision,
    globalKillSwitch: policy.globalKillSwitch,
    values: policy.values,
  })
}

export function invalidRiskEvaluation(policy: EffectiveRiskPolicy, code: string, now = new Date()): RiskEvaluationResult {
  return result('rejected', code, [{ code, outcome: 'rejected', actionId: null, details: {} }], [], policy, now)
}

function hash(value: unknown) {
  const canonical = (node: unknown): string => {
    if (node === null || typeof node !== 'object') return JSON.stringify(node)
    if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`
    const record = node as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
