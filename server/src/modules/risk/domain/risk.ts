import type { RiskPolicyValues, AccountRiskPolicyPatch, RiskPolicyBoundary, EffectiveRiskPolicy, AccountRiskSummary } from './risk-state.js'
export type { RiskPolicyValues, AccountRiskPolicyPatch, RiskPolicyBoundary, EffectiveRiskPolicy, AccountRiskSummary } from './risk-state.js'
import { createHash } from 'node:crypto'
import type { RiskJsonObject, RiskAction, RiskDecisionInput } from './risk-action.js'
import { manualReleaseApplies, type ManualReleaseRuleCode, type ManualRiskRelease } from './manual-risk-release.js'
import { resolvePositionTierActions, type PositionSizingContext } from './position-tier-actions.js'
import { PositionSizingError, positionVolumeExceedsRiskBudget } from './position-tier-sizing.js'
import type { StrategyBudgetContext } from './strategy-budget-context.js'
import { actionRiskCeiling } from './action-risk-ceiling.js'
import { PartialCloseError, resolvePartialCloseActions } from './partial-close-actions.js'

export type RiskDecisionStatus = 'approved' | 'rejected'
export type RiskRuleOutcome = 'passed' | 'rejected' | 'not_applicable'

export interface RiskInstrumentSnapshot {
  symbol: string
  point: string
  tickSize: string
  tickValue: string
  volumeMin: string
  volumeMax: string
  volumeStep: string
  tradeEnabled: boolean
  allowedOpenSides?: Array<'buy' | 'sell'>
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
  details: RiskJsonObject
}

export interface RiskEvaluationInput {
  /** Trusted server evidence only; never copied from model action parameters. */
  frozenPositions?: { positions: unknown[]; revision: number }
  positionSizingContext?: PositionSizingContext
  strategyBudgetContext?: StrategyBudgetContext
  decisionId: string
  decisionRevision: number
  decisionCreatedAt: string
  decisionStatus: 'proposed'
  result: RiskDecisionInput
  policy: EffectiveRiskPolicy
  summary: AccountRiskSummary
  quote: RiskQuoteSnapshot
  instrument: RiskInstrumentSnapshot
  positions: RiskJsonObject[]
  pendingOrders: RiskJsonObject[]
  manualRelease?: ManualRiskRelease | null
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
  /**
   * AI decisions bind every captured revision. Non-AI execution sources may
   * explicitly narrow this list to the account/market/resource revisions they
   * actually captured. Omitting the field keeps the stricter AI default.
   */
  requiredRevisionKeys?: Array<keyof RiskEvaluationInput['currentRevisions']>
}

export interface RiskEvaluationResult {
  status: RiskDecisionStatus
  rejectCode: string | null
  rules: RiskRuleResult[]
  approvedActions: RiskAction[]
  evaluatedAt: string
  policyHash: string
  manualReleaseId: string | null
  manualReleaseRevision: number | null
}

export class RiskError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code) }
}

export const DEFAULT_RISK_POLICY: Readonly<RiskPolicyValues> = Object.freeze({
  allowedSymbols: ['*'], requireStopLoss: true, failClosedOnIncompleteData: true,
  maxRiskPerTradePercent: 1, maxDailyLossPercent: 3, maxDrawdownPercent: 8,
  maxOpenPositions: 10, maxPendingOrders: 20, maxTotalVolume: 5, maxOrderVolume: 0.05, maxSpreadPoints: 120,
  maxQuoteAgeSeconds: 15, maxRiskSummaryAgeSeconds: 30, maxDecisionAgeSeconds: 300, maxPriceDeviationPercent: 0.1,
  manualReleaseEnabled: true, manualReleaseMaxDailyLossPercent: 5, manualReleaseMaxDrawdownPercent: 12,
  manualReleaseMaxDailyOpenCount: 30, manualReleaseConsecutiveLossLimit: 5,
  minOpenIntervalSeconds: 30, maxDailyOpenCount: 20, consecutiveLossLimit: 3,
  lossCooldownMinutes: 60, pendingValidMinutes: 180, pendingDedupAtrMultiplier: 0.05, weekendCloseMinutes: 60,
  tradeSendEnabled: true, accountKillSwitch: false,
})

export const ACCOUNT_EDITABLE_FIELDS: Array<keyof AccountRiskPolicyPatch> = [
  'maxRiskPerTradePercent', 'maxDailyLossPercent', 'maxDrawdownPercent', 'maxOpenPositions',
  'maxPendingOrders', 'maxOrderVolume', 'maxTotalVolume', 'maxSpreadPoints', 'minOpenIntervalSeconds',
  'maxDailyOpenCount', 'consecutiveLossLimit', 'lossCooldownMinutes', 'pendingValidMinutes',
  'weekendCloseMinutes', 'accountKillSwitch',
]

/** V4 persisted policies may omit newer fields; all consumers use this one compatibility rule. */
export function readPlatformRiskValues(raw: string | object): RiskPolicyValues {
  let parsed: unknown = raw
  try { if (typeof raw === 'string') parsed = JSON.parse(raw) }
  catch { throw new RiskError('risk_platform_policy_invalid', 409) }
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(parsed)) throw new RiskError('risk_platform_policy_invalid', 409)
  const wrapped = Object.hasOwn(parsed, 'values')
  if (wrapped && Object.keys(parsed).some(key => !['values', 'controls'].includes(key))) throw new RiskError('risk_platform_policy_unmapped', 409)
  const values = wrapped ? parsed.values : parsed
  if (!isObject(values)) throw new RiskError('risk_platform_policy_invalid', 409)
  if (Object.keys(values).some(key => !Object.hasOwn(DEFAULT_RISK_POLICY, key))) throw new RiskError('risk_platform_policy_unmapped', 409)
  // Missing maxOrderVolume in old V4 JSON resolves to 0.05, never maxTotalVolume.
  // Legacy snake_case policies and independent controls require explicit migration.
  const merged = { ...DEFAULT_RISK_POLICY, ...values } as RiskPolicyValues
  const validated = assertPolicyValues(merged)
  if (wrapped && Object.hasOwn(parsed, 'controls')) validateRiskPolicyControls(parsed.controls, validated)
  return validated
}

export function readPlatformRiskControls(raw: string | object): NonNullable<RiskPolicyBoundary['controls']> {
  const values = readPlatformRiskValues(raw)
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
  return validateRiskPolicyControls(Object.hasOwn(parsed, 'values') ? parsed.controls ?? {} : {}, values)
}

const lowerIsSafer = new Set<keyof AccountRiskPolicyPatch>([
  'maxRiskPerTradePercent', 'maxDailyLossPercent', 'maxDrawdownPercent', 'maxOpenPositions',
  'maxPendingOrders', 'maxOrderVolume', 'maxTotalVolume', 'maxSpreadPoints', 'maxDailyOpenCount',
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
  const platform = assertPolicyValues({ ...input.platform.values, tradeSendEnabled: true, accountKillSwitch: false })
  const controls = validateRiskPolicyControls(input.platform.controls ?? {}, platform)
  for (const [key, control] of Object.entries(controls)) {
    const field = key as keyof RiskPolicyValues
    ;(platform[field] as number) = control!.lockedValue ?? Math.min(control!.allowedMax, Math.max(control!.allowedMin, platform[field] as number))
  }
  assertPolicyValues(platform)
  const values: RiskPolicyValues = { ...platform, allowedSymbols: [...platform.allowedSymbols] }
  for (const key of ACCOUNT_EDITABLE_FIELDS) {
    const control = controls[key]
    if ((control?.lockedValue !== null && control?.lockedValue !== undefined) || control?.userEditable === false) continue
    const candidate = input.account?.[key]
    if (candidate === undefined) continue
    if (typeof values[key] === 'boolean') {
      ;(values[key] as boolean) = Boolean(candidate)
      continue
    }
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new RiskError(`risk_policy_${String(key)}_invalid`, 422)
    if (control) {
      if (candidate < control.allowedMin || candidate > control.allowedMax) throw new RiskError(`risk_policy_${String(key)}_boundary_invalid`, 422)
      ;(values[key] as number) = candidate
      continue
    }
    const boundary = platform[key]
    if (typeof boundary !== 'number') throw new RiskError(`risk_policy_${String(key)}_invalid`, 422)
    if (lowerIsSafer.has(key) && candidate > boundary) throw new RiskError(`risk_policy_${String(key)}_relaxation_forbidden`, 422)
    if (higherIsSafer.has(key) && candidate < boundary) throw new RiskError(`risk_policy_${String(key)}_relaxation_forbidden`, 422)
    ;(values[key] as number) = candidate
  }
  values.requireStopLoss = true
  values.failClosedOnIncompleteData = true
  assertPolicyValues(values)
  return {
    accountId: input.accountId, userId: input.userId, platformPolicyVersionId: input.platformPolicyVersionId,
    accountPolicyVersionId: input.accountPolicyVersionId, policySetRevision: input.policySetRevision,
    globalKillSwitch: input.platform.globalKillSwitch,
    numericControls: controls, values, editableFields: ACCOUNT_EDITABLE_FIELDS.filter(key => !controls[key] || (controls[key]!.userEditable && controls[key]!.lockedValue === null)), updatedAt: input.updatedAt,
  }
}

export function validateRiskPolicyControls(raw: unknown, platform: RiskPolicyValues): NonNullable<RiskPolicyBoundary['controls']> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RiskError('risk_platform_controls_invalid', 409)
  const result: NonNullable<RiskPolicyBoundary['controls']> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_RISK_POLICY, key)) throw new RiskError('risk_platform_policy_unmapped', 409)
    if (typeof platform[key as keyof RiskPolicyValues] !== 'number'
      || !value || typeof value !== 'object' || Array.isArray(value)) throw new RiskError('risk_platform_control_invalid', 409)
    if (Object.keys(value).sort().join(',') !== 'allowedMax,allowedMin,lockedValue,userEditable') throw new RiskError('risk_platform_control_invalid', 409)
    const control = value as import('./risk-state.js').RiskNumericControl
    if (!Number.isFinite(control.allowedMin) || !Number.isFinite(control.allowedMax) || control.allowedMin < 0
      || control.allowedMin > control.allowedMax || typeof control.userEditable !== 'boolean'
      || control.lockedValue !== null && (!Number.isFinite(control.lockedValue) || control.lockedValue < control.allowedMin || control.lockedValue > control.allowedMax)) {
      throw new RiskError('risk_platform_control_invalid', 409)
    }
    // Reuse field validation for integer counts and positive durations; cross-field
    // manual-release relationships are validated after effective values are resolved.
    const integral = ['maxOpenPositions', 'maxPendingOrders', 'maxQuoteAgeSeconds', 'maxRiskSummaryAgeSeconds', 'maxDecisionAgeSeconds',
      'manualReleaseMaxDailyOpenCount', 'manualReleaseConsecutiveLossLimit', 'minOpenIntervalSeconds', 'maxDailyOpenCount',
      'consecutiveLossLimit', 'lossCooldownMinutes', 'pendingValidMinutes', 'weekendCloseMinutes'].includes(key)
    if (integral && ![control.allowedMin, control.allowedMax, control.lockedValue ?? control.allowedMin].every(Number.isSafeInteger)) throw new RiskError('risk_platform_control_invalid', 409)
    if (['maxQuoteAgeSeconds', 'maxRiskSummaryAgeSeconds', 'maxDecisionAgeSeconds', 'pendingValidMinutes', 'maxOrderVolume'].includes(key)
      && control.allowedMin <= 0) throw new RiskError('risk_platform_control_invalid', 409)
    if (key === 'pendingDedupAtrMultiplier' && (control.allowedMax > 5 || control.userEditable)) throw new RiskError('risk_platform_control_invalid', 409)
    result[key as keyof RiskPolicyValues] = { ...control }
  }
  return result
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
  const reject = (code: string, actionId: string | null = null, details: RiskJsonObject = {}): RiskEvaluationResult => {
    rules.push({ code, outcome: 'rejected', actionId, details })
    return result('rejected', code, rules, [], input.policy, now)
  }
  const pass = (code: string, details: RiskJsonObject = {}) => rules.push({ code, outcome: 'passed' as const, actionId: null, details })
  let releaseApplied = false
  const accountLimit = (triggered: boolean, code: ManualReleaseRuleCode, platformLimitReached = false) => {
    if (!triggered) return null
    if (platformLimitReached) return `RISK_PLATFORM_${code.slice('RISK_'.length)}`
    if (!manualReleaseApplies(input.manualRelease, code, input.policy, input.summary, now)) return code
    releaseApplied = true
    pass('RISK_MANUAL_RELEASE_APPLIED', { released_rule: code, manual_release_id: input.manualRelease!.id })
    return null
  }

  if (input.summary.accountId !== input.policy.accountId || input.summary.userId !== input.policy.userId) return reject('RISK_ACCOUNT_SCOPE_MISMATCH')
  try { for (const action of input.result.actions) actionRiskCeiling(action) }
  catch (error) {
    if (error instanceof PositionSizingError) return reject(`RISK_${error.code.toUpperCase()}`)
    throw error
  }
  if (input.strategyBudgetContext) {
    const context = input.strategyBudgetContext
    if (context.decisionId !== input.decisionId || context.decisionRevision !== input.decisionRevision
      || context.userId !== input.policy.userId || context.accountId !== input.policy.accountId
      || context.subscriptionRevision !== input.currentRevisions.subscription) return reject('RISK_STRATEGY_BUDGET_CONTEXT_STALE')
    pass('RISK_STRATEGY_BUDGET_VERIFIED', { strategy_id: context.strategyId, version_id: context.versionId,
      snapshot_id: context.snapshotId, snapshot_hash: context.snapshotHash, decision_hash: context.decisionHash,
      prompt_hash: context.promptHash, config_hash: context.configHash,
      strategy_risk_ceiling_percent: context.strategyRiskCeilingPercent ?? null,
      ...(context.strategyRiskSelection ? { strategy_risk_selection: { ...context.strategyRiskSelection } } : {}) })
  }
  if (input.summary.revision !== input.currentRevisions.risk) return reject('RISK_SUMMARY_REVISION_STALE')
  const requiredRevisionKeys = input.requiredRevisionKeys ?? Object.keys(input.currentRevisions) as Array<keyof RiskEvaluationInput['currentRevisions']>
  for (const action of input.result.actions) {
    const expected = expectedState(action)
    for (const key of requiredRevisionKeys) {
      const current = input.currentRevisions[key]
      if (expected[`${key}Revision`] !== current) return reject('RISK_EXPECTED_STATE_STALE', action.actionId, { resource: key })
    }
  }
  pass('RISK_EXPECTED_STATE_CURRENT')

  if (input.result.action === 'hold') {
    pass('RISK_HOLD_NO_EXECUTION')
    return result('approved', null, rules, [], input.policy, now)
  }

  let closePrepared: ReturnType<typeof resolvePartialCloseActions>
  try { closePrepared = resolvePartialCloseActions(input) }
  catch (error) {
    if (error instanceof PartialCloseError) return reject(`RISK_${error.code.toUpperCase()}`)
    throw error
  }
  rules.push(...closePrepared.rules)

  for (const action of riskReducing) {
    const ticket = String(action.parameters.ticket ?? '')
    const inventory = action.kind === 'cancel_order' || action.kind === 'modify_order' ? input.pendingOrders : input.positions
    if (!inventory.some(item => String(item.ticket ?? '') === ticket)) return reject('RISK_TARGET_NOT_FOUND', action.actionId)
  }
  if (riskIncreasing.length === 0) {
    pass('RISK_REDUCING_ACTION_ALLOWED')
    return result('approved', null, rules, closePrepared.actions, input.policy, now)
  }

  if (input.policy.globalKillSwitch) return reject('RISK_GLOBAL_KILL_SWITCH')
  if (policy.accountKillSwitch) return reject('RISK_ACCOUNT_KILL_SWITCH')
  if (!input.summary.dataComplete) return reject('RISK_DATA_INCOMPLETE', null, { reasons: input.summary.incompleteReasons })
  const summaryAge = ageSeconds(input.summary.observedAt, now)
  if (summaryAge === null || summaryAge < -5) return reject('RISK_SUMMARY_TIME_INVALID')
  if (summaryAge > policy.maxRiskSummaryAgeSeconds) return reject('RISK_SUMMARY_STALE')
  const dailyLossBlock = accountLimit(input.summary.dailyLossPercent >= policy.maxDailyLossPercent, 'RISK_DAILY_LOSS_LIMIT', input.summary.dailyLossPercent >= policy.manualReleaseMaxDailyLossPercent)
  if (dailyLossBlock) return reject(dailyLossBlock)
  const drawdownBlock = accountLimit(input.summary.drawdownPercent >= policy.maxDrawdownPercent, 'RISK_DRAWDOWN_LIMIT', input.summary.drawdownPercent >= policy.manualReleaseMaxDrawdownPercent)
  if (drawdownBlock) return reject(drawdownBlock)
  const dailyOpenBlock = accountLimit(input.summary.dailyOpenCount >= policy.maxDailyOpenCount, 'RISK_DAILY_OPEN_LIMIT', input.summary.dailyOpenCount >= policy.manualReleaseMaxDailyOpenCount)
  if (dailyOpenBlock) return reject(dailyOpenBlock)
  const consecutiveLossBlock = accountLimit(input.summary.consecutiveLosses >= policy.consecutiveLossLimit, 'RISK_CONSECUTIVE_LOSS_LIMIT', input.summary.consecutiveLosses >= policy.manualReleaseConsecutiveLossLimit)
  if (consecutiveLossBlock) return reject(consecutiveLossBlock)
  const cooldownBlock = accountLimit(Boolean(input.summary.cooldownUntil && Date.parse(input.summary.cooldownUntil) > now.getTime()), 'RISK_COOLDOWN_ACTIVE')
  if (cooldownBlock) return reject(cooldownBlock)
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

  let prepared: ReturnType<typeof resolvePositionTierActions>
  try { prepared = resolvePositionTierActions({ ...input, result: { ...input.result, actions: closePrepared.actions } }, riskPolicyHash(input.policy)) }
  catch (error) {
    if (error instanceof PositionSizingError) return reject(`RISK_${error.code.toUpperCase()}`)
    throw error
  }
  rules.push(...prepared.rules)
  let addedVolume = 0
  for (const action of riskIncreasing) {
    const actionResult = evaluateAction(prepared.actions[input.result.actions.indexOf(action)]!, input, ask, bid)
    rules.push(...actionResult.rules)
    if (actionResult.rejectCode) return result('rejected', actionResult.rejectCode, rules, [], input.policy, now)
    addedVolume += actionResult.addedVolume
  }
  if (Number(input.summary.totalVolume) + addedVolume > policy.maxTotalVolume + 1e-9) return reject('RISK_TOTAL_VOLUME_LIMIT')
  pass('RISK_POLICY_APPROVED', { added_volume: Number(addedVolume.toFixed(8)) })
  return result('approved', null, rules, prepared.actions, input.policy, now, releaseApplied ? input.manualRelease ?? null : null)
}

function evaluateAction(action: RiskAction, input: RiskEvaluationInput, ask: number, bid: number) {
  const rules: RiskRuleResult[] = []
  const fail = (code: string, details: RiskJsonObject = {}) => ({ rejectCode: code, addedVolume: 0, rules: [...rules, { code, outcome: 'rejected' as const, actionId: action.actionId, details }] })
  const pass = (code: string, details: RiskJsonObject = {}) => rules.push({ code, outcome: 'passed' as const, actionId: action.actionId, details })
  if (action.kind === 'modify_position' || action.kind === 'modify_order') {
    const inventory = action.kind === 'modify_position' ? input.positions : input.pendingOrders
    const item = inventory.find(candidate => String(candidate.ticket ?? '') === String(action.parameters.ticket ?? ''))
    if (!item) return fail('RISK_TARGET_NOT_FOUND')
    if (action.parameters.remove_stop_loss === true) return fail('RISK_STOP_LOSS_REQUIRED')
    const side = action.kind === 'modify_position'
      ? String(item.side ?? '')
      : String(item.type ?? '').startsWith('buy') ? 'buy' : String(item.type ?? '').startsWith('sell') ? 'sell' : ''
    if (side !== 'buy' && side !== 'sell') return fail('RISK_ACTION_SIDE_INVALID')
    const changesStop = action.parameters.stop_loss !== undefined || action.parameters.sl !== undefined
    if (changesStop) {
      const stop = decimal(action.parameters.stop_loss ?? action.parameters.sl, 'risk_action_stop_loss_invalid')
      const entry = decimal(action.kind === 'modify_position'
        ? item.openPrice ?? item.open_price ?? item.currentPrice ?? item.current_price
        : action.parameters.price ?? item.price, 'risk_action_price_invalid')
      const volume = decimal(action.parameters.volume ?? item.volume, 'risk_action_volume_invalid')
      const current = side === 'buy' ? bid : ask
      if (stop <= 0 || entry <= 0 || volume <= 0 || (side === 'buy' ? stop >= current : stop <= current)) return fail('RISK_STOP_LOSS_DIRECTION_INVALID')
      if (action.kind === 'modify_order') {
        const oldVolume = decimal(item.volume, 'risk_action_volume_invalid')
        if (volume > oldVolume + 1e-9 || volume > input.policy.values.maxOrderVolume + 1e-9) return fail('RISK_ORDER_VOLUME_LIMIT')
      }
      const tickSize = decimal(input.instrument.tickSize, 'risk_instrument_tick_invalid')
      const tickValue = decimal(input.instrument.tickValue, 'risk_instrument_tick_invalid')
      const equity = decimal(input.summary.equity, 'risk_summary_equity_invalid')
      if (tickSize <= 0 || tickValue <= 0 || equity <= 0) return fail('RISK_CALCULATION_DATA_INVALID')
      const lossDistance = side === 'buy' ? Math.max(0, entry - stop) : Math.max(0, stop - entry)
      const riskAmount = lossDistance / tickSize * tickValue * volume
      const riskPercent = riskAmount / equity * 100
      if (riskPercent > input.policy.values.maxRiskPerTradePercent + 1e-9) return fail('RISK_PER_TRADE_LIMIT', { risk_percent: Number(riskPercent.toFixed(6)) })
      pass('RISK_MODIFICATION_RECALCULATED', { risk_amount: Number(riskAmount.toFixed(8)), risk_percent: Number(riskPercent.toFixed(6)) })
    }
    const takeProfit = action.parameters.take_profit ?? action.parameters.tp
    if (takeProfit !== undefined && takeProfit !== null) {
      const target = decimal(takeProfit, 'risk_action_take_profit_invalid')
      if (target <= 0 || (side === 'buy' ? target <= bid : target >= ask)) return fail('RISK_TAKE_PROFIT_DIRECTION_INVALID')
    }
    return { rejectCode: null, addedVolume: 0, rules }
  }
  if (action.kind !== 'market_order' && action.kind !== 'pending_order') return { rejectCode: null, addedVolume: 0, rules }
  const params = action.parameters
  const side = String(params.side ?? (String(params.type ?? '').startsWith('buy') ? 'buy' : String(params.type ?? '').startsWith('sell') ? 'sell' : ''))
  if (side !== 'buy' && side !== 'sell') return fail('RISK_ACTION_SIDE_INVALID')
  if (input.instrument.allowedOpenSides && !input.instrument.allowedOpenSides.includes(side)) return fail('RISK_INSTRUMENT_DIRECTION_DISABLED')
  const volume = decimal(params.volume, 'risk_action_volume_invalid')
  const stopLoss = decimal(params.stop_loss ?? params.sl, 'risk_action_stop_loss_invalid')
  const entry = action.kind === 'market_order' ? (side === 'buy' ? ask : bid) : decimal(params.price, 'risk_action_price_invalid')
  if (volume <= 0 || entry <= 0 || stopLoss <= 0) return fail('RISK_ACTION_NUMERIC_INVALID')
  if (volume > input.policy.values.maxOrderVolume + 1e-9) return fail('RISK_ORDER_VOLUME_LIMIT')
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
  const actionCeiling = actionRiskCeiling(action)
  try {
    if (positionVolumeExceedsRiskBudget({ equity: input.summary.equity,
      maxRiskPerTradePercent: String(input.policy.values.maxRiskPerTradePercent), volume: String(params.volume),
      ...(actionCeiling === undefined ? {} : { actionRiskCeilingPercent: actionCeiling }),
      ...(input.strategyBudgetContext?.strategyRiskCeilingPercent === undefined ? {} : { strategyRiskCeilingPercent: input.strategyBudgetContext.strategyRiskCeilingPercent }),
      entry: String(action.kind === 'market_order' ? (side === 'buy' ? input.quote.ask : input.quote.bid) : params.price),
      stopLoss: String(params.stop_loss ?? params.sl), tickSize: input.instrument.tickSize, tickValue: input.instrument.tickValue,
    })) return fail('RISK_PER_TRADE_LIMIT', { risk_percent: Number(riskPercent.toFixed(6)) })
  } catch (error) {
    if (error instanceof PositionSizingError) return fail('RISK_CALCULATION_DATA_INVALID')
    throw error
  }
  if (params.reference_price === undefined) return fail('RISK_REFERENCE_PRICE_REQUIRED')
  const reference = decimal(params.reference_price, 'risk_reference_price_invalid')
  if (reference <= 0) return fail('RISK_REFERENCE_PRICE_INVALID')
  if (Math.abs(entry - reference) / reference * 100 > input.policy.values.maxPriceDeviationPercent) return fail('RISK_PRICE_DEVIATION_LIMIT')
  pass('RISK_ACTION_APPROVED', {
    action_risk_ceiling_percent: actionCeiling ?? null,
    risk_amount: Number(riskAmount.toFixed(8)),
    risk_percent: Number(riskPercent.toFixed(6)),
    volume,
  })
  return { rejectCode: null, addedVolume: volume, rules }
}

function expectedState(action: RiskAction) {
  const value = action.expectedState
  return value as Record<string, unknown>
}

function isRiskReducing(action: RiskAction, input: RiskEvaluationInput) {
  if (action.kind === 'close_position' || action.kind === 'cancel_order') return true
  const ticket = String(action.parameters.ticket ?? '')
  if (action.kind === 'modify_position') {
    const position = input.positions.find(item => String(item.ticket ?? '') === ticket)
    if (!position) return false
    if (action.parameters.remove_stop_loss === true) return false
    const changesStop = action.parameters.stop_loss !== undefined && action.parameters.stop_loss !== null
      || action.parameters.sl !== undefined && action.parameters.sl !== null
    const side = String(position.side ?? '')
    const currentPrice = Number(position.currentPrice ?? position.current_price)
    if (!changesStop && action.parameters.remove_take_profit === true) return true
    if (!changesStop && (action.parameters.take_profit !== undefined || action.parameters.tp !== undefined)) {
      const target = Number(action.parameters.take_profit ?? action.parameters.tp)
      return target > 0 && currentPrice > 0 && (side === 'buy' ? target > currentPrice : side === 'sell' ? target < currentPrice : false)
    }
    const oldStop = Number(position.stopLoss ?? position.stop_loss ?? 0)
    const newStop = Number(action.parameters.stop_loss ?? action.parameters.sl)
    if (!(newStop > 0 && currentPrice > 0)) return false
    return side === 'buy' ? newStop < currentPrice && (oldStop <= 0 || newStop >= oldStop)
      : side === 'sell' ? newStop > currentPrice && (oldStop <= 0 || newStop <= oldStop) : false
  }
  if (action.kind === 'modify_order') {
    const order = input.pendingOrders.find(item => String(item.ticket ?? '') === ticket)
    if (!order) return false
    if (action.parameters.remove_stop_loss === true) return false
    const changesEntryRisk = action.parameters.price !== undefined && action.parameters.price !== null
      || action.parameters.volume !== undefined && action.parameters.volume !== null
      || action.parameters.stop_loss !== undefined && action.parameters.stop_loss !== null
      || action.parameters.sl !== undefined && action.parameters.sl !== null
    const changesOnlyNonRiskFields = !changesEntryRisk
      && (action.parameters.remove_take_profit === true || action.parameters.expiration_utc_msc !== undefined
        || action.parameters.remove_expiration === true)
    if (changesOnlyNonRiskFields) return true
    if (!changesEntryRisk && (action.parameters.take_profit !== undefined || action.parameters.tp !== undefined)) {
      const target = Number(action.parameters.take_profit ?? action.parameters.tp), entry = Number(order.price)
      const type = String(order.type ?? '')
      return target > 0 && entry > 0 && (type.startsWith('buy') ? target > entry : type.startsWith('sell') ? target < entry : false)
    }
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
  if (typeof value.maxOrderVolume !== 'number' || !Number.isFinite(value.maxOrderVolume) || value.maxOrderVolume <= 0) throw new RiskError('risk_platform_order_volume_invalid', 500)
  if (typeof value.pendingDedupAtrMultiplier !== 'number' || !Number.isFinite(value.pendingDedupAtrMultiplier)
    || value.pendingDedupAtrMultiplier < 0 || value.pendingDedupAtrMultiplier > 5) throw new RiskError('risk_platform_pending_dedup_invalid', 500)
  if (value.requireStopLoss !== true || value.failClosedOnIncompleteData !== true) throw new RiskError('risk_platform_mandatory_rule_invalid', 500)
  if (!Array.isArray(value.allowedSymbols)) throw new RiskError('risk_allowed_symbols_invalid', 500)
  const allowedSymbols = [...new Set(value.allowedSymbols.map(symbol => typeof symbol === 'string' ? symbol.trim().toUpperCase() : '').filter(Boolean))]
  if (allowedSymbols.length === 0) throw new RiskError('risk_allowed_symbols_invalid', 500)
  const numeric = Object.entries(value).filter(([key]) => !['allowedSymbols', 'requireStopLoss', 'failClosedOnIncompleteData', 'manualReleaseEnabled', 'tradeSendEnabled', 'accountKillSwitch'].includes(key))
  if (numeric.some(([, candidate]) => typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) throw new RiskError('risk_platform_numeric_rule_invalid', 500)
  if (![value.maxOpenPositions, value.maxPendingOrders, value.maxQuoteAgeSeconds, value.maxRiskSummaryAgeSeconds,
    value.maxDecisionAgeSeconds, value.manualReleaseMaxDailyOpenCount, value.manualReleaseConsecutiveLossLimit,
    value.minOpenIntervalSeconds, value.maxDailyOpenCount, value.consecutiveLossLimit,
    value.lossCooldownMinutes, value.pendingValidMinutes, value.weekendCloseMinutes].every(Number.isSafeInteger)) throw new RiskError('risk_platform_integer_rule_invalid', 500)
  if (value.maxQuoteAgeSeconds < 1 || value.maxRiskSummaryAgeSeconds < 1 || value.maxDecisionAgeSeconds < 1 || value.pendingValidMinutes < 1) throw new RiskError('risk_platform_duration_rule_invalid', 500)
  if (value.manualReleaseEnabled && (value.manualReleaseMaxDailyLossPercent < value.maxDailyLossPercent || value.manualReleaseMaxDrawdownPercent < value.maxDrawdownPercent
    || value.manualReleaseMaxDailyOpenCount < value.maxDailyOpenCount || value.manualReleaseConsecutiveLossLimit < value.consecutiveLossLimit)) throw new RiskError('risk_platform_manual_release_boundary_invalid', 500)
  if (typeof value.manualReleaseEnabled !== 'boolean' || typeof value.tradeSendEnabled !== 'boolean' || typeof value.accountKillSwitch !== 'boolean') throw new RiskError('risk_platform_toggle_rule_invalid', 500)
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

function result(status: RiskDecisionStatus, rejectCode: string | null, rules: RiskRuleResult[], approvedActions: RiskAction[], policy: EffectiveRiskPolicy, now: Date, manualRelease: ManualRiskRelease | null = null): RiskEvaluationResult {
  return { status, rejectCode, rules, approvedActions, evaluatedAt: now.toISOString(), policyHash: riskPolicyHash(policy), manualReleaseId: manualRelease?.id ?? null, manualReleaseRevision: manualRelease?.revision ?? null }
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
