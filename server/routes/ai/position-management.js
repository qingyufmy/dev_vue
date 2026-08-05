import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { broadcastAdminEvent, getBridgeGeneration, sendToBrowsers } from '../../bridge-ws.js'
import { stripBrokerSuffix } from './utils.js'

export const POSITION_MANAGEMENT_CONTRACT_VERSION = 'position-management-v1.2'
export const POSITION_MANAGEMENT_MODES = ['display', 'auto_exit', 'auto_reverse']
export const POSITION_MANAGEMENT_MAX_GROUPS = 20
export const POSITION_MANAGEMENT_MAX_CONTEXT_CHARS = 32_000
export const AUTO_EXIT_CONFIRMATIONS_REQUIRED = 2

const SYSTEM_MAGIC = 234000
const MODE_RANK = new Map(POSITION_MANAGEMENT_MODES.map((mode, index) => [mode, index]))
const TERMINAL_STATES = new Set(['HELD', 'EXPIRED', 'REJECTED', 'FAILED', 'COMPLETED', 'EXIT_ONLY_COMPLETED'])
const TRANSITIONS = new Map(Object.entries({
  CANDIDATE:['EVIDENCE_CONFIRMED', 'HELD', 'EXPIRED', 'REJECTED'],
  // The worker commits the lock and executable intent atomically.  Keep the
  // legacy lock state recoverable/manual-only; it must never be created by the
  // generic transition API as a stable externally visible state.
  EVIDENCE_CONFIRMED:['HELD', 'EXPIRED', 'REJECTED', 'MANUAL_REVIEW'],
  PRECONDITIONS_LOCKED:['FAILED', 'MANUAL_REVIEW'],
  PENDING_CANCEL_INTENT:['PENDING_CANCEL_SENT', 'FAILED', 'MANUAL_REVIEW'],
  PENDING_CANCEL_SENT:['PENDING_RECONCILING', 'PENDING_UNCERTAIN'],
  PENDING_RECONCILING:['PENDING_CANCEL_CONFIRMED', 'PENDING_FILLED_DURING_CANCEL', 'PENDING_UNCERTAIN'],
  PENDING_CANCEL_CONFIRMED:['CLOSE_INTENT_CREATED', 'COMPLETED'],
  PENDING_FILLED_DURING_CANCEL:['MANUAL_REVIEW'],
  PENDING_UNCERTAIN:['PENDING_RECONCILING', 'MANUAL_REVIEW'],
  CLOSE_INTENT_CREATED:['CLOSE_SENT', 'FAILED', 'MANUAL_REVIEW'],
  CLOSE_SENT:['CLOSE_RECONCILING', 'CLOSE_PARTIAL', 'CLOSE_UNCERTAIN'],
  CLOSE_RECONCILING:['CLOSE_CONFIRMED', 'CLOSE_PARTIAL', 'CLOSE_UNCERTAIN'],
  CLOSE_PARTIAL:['CLOSE_RECONCILING', 'MANUAL_REVIEW'],
  CLOSE_UNCERTAIN:['CLOSE_RECONCILING', 'MANUAL_REVIEW'],
  CLOSE_CONFIRMED:['EXIT_ONLY_COMPLETED', 'REENTRY_RISK_CHECKED'],
  REENTRY_RISK_CHECKED:['REENTRY_INTENT_CREATED', 'EXIT_ONLY_COMPLETED'],
  REENTRY_INTENT_CREATED:['REENTRY_SENT', 'FAILED'],
  REENTRY_SENT:['REENTRY_RECONCILING'],
  REENTRY_RECONCILING:['COMPLETED', 'MANUAL_REVIEW'],
  MANUAL_REVIEW:['PENDING_RECONCILING', 'CLOSE_RECONCILING', 'EXIT_ONLY_COMPLETED', 'FAILED'],
}))

const object = value => value && !Array.isArray(value) && typeof value === 'object' ? value : null
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const number = value => Number.isFinite(Number(value)) ? Number(value) : null
const json = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
const canonicalJson = value => Array.isArray(value) ? value.map(canonicalJson)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]))
    : value
const sameJsonPayload = (left, right) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const stableId = (prefix, parts) => `${prefix}_${hash(parts).slice(0, 32)}`

function normalizeDirection(value) {
  const raw = String(value || '').toLowerCase()
  if (raw.startsWith('buy')) return 'buy'
  if (raw.startsWith('sell')) return 'sell'
  return null
}

function normalizeMode(value, fallback = 'display') {
  const mode = String(value || '').toLowerCase()
  if (mode === 'shadow') return 'display'
  return MODE_RANK.has(mode) ? mode : fallback
}

function effectiveMode(userMode, maximumMode) {
  const requested = normalizeMode(userMode)
  const maximum = normalizeMode(maximumMode, 'display')
  return MODE_RANK.get(requested) <= MODE_RANK.get(maximum) ? requested : maximum
}

export function resolvePositionManagementTaskMode(taskType, userMode, control = {}) {
  // Pending-order cancellation is independent from automatic close and uses
  // its own platform switch.
  if (taskType === 'pending_cancel') {
    return Number(control.ai_pending_cancel_enabled ?? 1) === 1 ? 'auto_exit' : 'display'
  }
  return effectiveMode(userMode || 'auto_exit', control.maximum_mode || 'display')
}

export function targetMatchesPositionManagementTask(target, taskType) {
  const hasPosition = String(target?.position_id ?? '').trim().length > 0
  const hasPending = String(target?.pending_ticket ?? '').trim().length > 0
  const isActivePending = hasPending
    && String(target?.effective_pending_state || '').toLowerCase() === 'pending'
  if (taskType === 'pending_cancel') return hasPending && (!hasPosition || isActivePending)
  if (taskType === 'position_exit') return hasPosition && !isActivePending
  return false
}

function lastClosedBar(market, timeframe) {
  const frame = market?.strategy_context?.timeframes?.[timeframe]
  const explicit = frame?.summary?.last_closed_bar
  if (explicit && typeof explicit === 'object') return explicit
  const rows = frame?.klines
  if (!Array.isArray(rows) || rows.length === 0) return null
  return frame?.summary?.market_data_quality?.last_bar_closed === false
    ? rows.at(-2) || null
    : rows.at(-1) || null
}

function lastClosedBarTime(market, timeframe) {
  const row = lastClosedBar(market, timeframe)
  const direct = number(row?.time_utc_msc ?? row?.utc_time_msc ?? row?.time_msc)
  if (direct && direct > 0) return Math.trunc(direct)
  const seconds = number(row?.time_utc ?? row?.time)
  if (seconds && seconds > 0) return Math.trunc(seconds > 10_000_000_000 ? seconds : seconds * 1000)
  const parsed = Date.parse(String(market?.timestamp || ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function buildPositionManagementAsOf(market, decisionTimeframe) {
  const closedBarTimeUtcMs = lastClosedBarTime(market, decisionTimeframe)
  return {
    decision_timeframe:String(decisionTimeframe || market?.timeframe || '').toUpperCase(),
    closed_bar_time_utc_ms:closedBarTimeUtcMs,
    market_snapshot_hash:`sha256:${hash(market || {})}`,
  }
}

function frozenConditions(signal, decisionTimeframe, closedBarTimeUtcMs) {
  const direction = normalizeDirection(signal?.signal_type)
  const conditions = []
  const stopLoss = number(signal?.stop_loss_price)
  if (direction && stopLoss && stopLoss > 0) {
    conditions.push({
      condition_id:stableId('cond', ['protective_stop', direction, stopLoss, decisionTimeframe]),
      kind:'hard', type:'protective_stop', timeframe:decisionTimeframe,
      operator:direction === 'buy' ? 'closed_bar_lte' : 'closed_bar_gte', threshold:stopLoss,
      required_closed_bars:1, immutable:true,
    })
  }
  const narrative = text(signal?.invalidation_condition, 1000)
  if (narrative) {
    conditions.push({
      condition_id:stableId('cond', ['soft_thesis_invalidation', narrative, decisionTimeframe]),
      kind:'soft', type:'model_evidence', timeframe:decisionTimeframe,
      operator:'model_confirmed', threshold:null, required_closed_bars:2,
      description:narrative, immutable:true,
    })
  }
  const evidenceRefs = closedBarTimeUtcMs
    ? [`bar:${decisionTimeframe}:${closedBarTimeUtcMs}`, ...conditions.map(item => `condition:${item.condition_id}`)]
    : conditions.map(item => `condition:${item.condition_id}`)
  return { conditions, evidenceRefs }
}

export async function createTradeThesisTx(run, {
  signalId, strategyId, strategyVersion = 1, strategyScope = 'platform', ownerUserId = 0,
  signal, market, decisionTimeframe, modelProfileId = null, modelName = null,
} = {}) {
  const direction = normalizeDirection(signal?.signal_type)
  if (!signalId || !strategyId || !direction) return null
  const standardSymbol = stripBrokerSuffix(String(signal?.symbol || market?.symbol || market?.standard_symbol || '')).toUpperCase()
  if (!standardSymbol) return null
  const asOf = buildPositionManagementAsOf(market, decisionTimeframe)
  const thesisId = stableId('thesis', [signalId, strategyId, strategyVersion, standardSymbol, direction])
  const managementGroupId = stableId('group', [strategyId, strategyVersion, standardSymbol, thesisId, direction])
  const frozen = frozenConditions(signal, asOf.decision_timeframe, asOf.closed_bar_time_utc_ms)
  const takeProfits = [1, 2, 3].map(tier => number(signal?.[`take_profit_${tier}_price`])).filter(value => value && value > 0)
  const now = beijingNow()
  await run(`INSERT INTO ai_trade_theses
    (thesis_id, management_group_id, signal_id, strategy_id, strategy_version, strategy_scope,
     owner_user_id, standard_symbol, direction, entry_method, decision_timeframe,
     closed_bar_time_utc_ms, market_snapshot_hash, output_contract_version, model_profile_id,
     model_name, core_entry_reason, original_stop_loss, original_take_profits_json,
     invalidation_conditions_json, evidence_refs_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
    ON DUPLICATE KEY UPDATE thesis_id = thesis_id`, [
    thesisId, managementGroupId, signalId, strategyId, Number(strategyVersion) || 1,
    strategyScope, Number(ownerUserId) || 0, standardSymbol, direction,
    String(signal.entry_method || 'market'), asOf.decision_timeframe,
    asOf.closed_bar_time_utc_ms, asOf.market_snapshot_hash.replace(/^sha256:/, ''),
    POSITION_MANAGEMENT_CONTRACT_VERSION, modelProfileId || null, modelName || null,
    text(signal?.reasoning || signal?.decision_summary, 1000), number(signal?.stop_loss_price),
    JSON.stringify(takeProfits), JSON.stringify(frozen.conditions), JSON.stringify(frozen.evidenceRefs), now, now,
  ])
  await run('UPDATE ai_signals SET thesis_id = ?, management_group_id = ? WHERE id = ?', [thesisId, managementGroupId, signalId])
  return { thesisId, managementGroupId, conditions:frozen.conditions, evidenceRefs:frozen.evidenceRefs, asOf }
}

function publicGroup(row) {
  const conditions = json(row.invalidation_conditions_json, [])
  const evidenceRefs = json(row.evidence_refs_json, [])
  return {
    management_group_id:row.management_group_id,
    thesis_id:row.thesis_id,
    strategy_id:Number(row.strategy_id),
    strategy_version:Number(row.strategy_version || 1),
    standard_symbol:row.standard_symbol,
    direction:row.direction,
    original_signal_id:Number(row.origin_signal_id || row.signal_id),
    decision_timeframe:row.decision_timeframe,
    frozen_conditions:Array.isArray(conditions) ? conditions : [],
    allowed_evidence_refs:Array.isArray(evidenceRefs) ? evidenceRefs : [],
  }
}

export function isActivePositionManagementOutcome(row) {
  if (row?.pending_ticket
    && String(row?.effective_pending_state || '').toLowerCase() === 'pending') return true
  if (row?.position_id) return true
  return false
}

function evaluateFrozenConditions(conditions, market) {
  return (Array.isArray(conditions) ? conditions : []).map(condition => {
    const base = { ...condition, evaluation_state:'unknown', observed_close:null, observed_bar_time_utc_ms:null }
    const timeframe = String(condition?.timeframe || '').trim()
    const row = lastClosedBar(market, timeframe)
    const observedClose = number(row?.close ?? row?.c ?? row?.price_close)
    const observedTime = lastClosedBarTime(market, timeframe)
    if (condition?.kind !== 'hard') {
      return { ...base, evaluation_reason:'model_required' }
    }
    if (!(observedClose != null && Number.isFinite(observedTime))) {
      return { ...base, evaluation_reason:'closed_bar_unavailable' }
    }
    const threshold = number(condition?.threshold)
    if (threshold == null) return { ...base, evaluation_reason:'threshold_unavailable' }
    let state = 'unknown'
    if (condition.operator === 'closed_bar_lte') state = observedClose <= threshold ? 'triggered' : 'not_triggered'
    else if (condition.operator === 'closed_bar_gte') state = observedClose >= threshold ? 'triggered' : 'not_triggered'
    return {
      ...base,
      evaluation_state:state,
      evaluation_reason:state === 'unknown' ? 'operator_unavailable' : null,
      observed_close:observedClose,
      observed_bar_time_utc_ms:observedTime,
    }
  })
}

function normalizePositionManagementOutcome(row) {
  const activePending = Boolean(row?.pending_ticket)
    && String(row?.effective_pending_state || '').toLowerCase() === 'pending'
  return activePending && row?.position_id ? { ...row, position_id:null } : row
}

export async function loadActivePositionManagementContext({
  strategyId, strategyVersion = null, strategyScope = 'platform', ownerUserId = 0,
  symbol, market, decisionTimeframe,
} = {}) {
  const standardSymbol = stripBrokerSuffix(String(symbol || '')).toUpperCase()
  const params = [Number(strategyId), standardSymbol]
  const privateWhere = strategyScope === 'private' ? ' AND outcomes.user_id = ?' : ''
  if (privateWhere) params.push(Number(ownerUserId))
  const rows = await queryAll(`SELECT outcomes.id AS outcome_id, outcomes.user_id, outcomes.trading_account_id,
      outcomes.ownership_history_id, outcomes.broker_server_key, outcomes.login_account,
      outcomes.original_symbol, outcomes.symbol, outcomes.pending_ticket, outcomes.position_id,
      outcomes.entry_direction, outcomes.system_magic, outcomes.attribution_status,
      outcomes.protection_status, outcomes.actual_stop_loss, outcomes.actual_take_profit,
      COALESCE(deliveries.pending_state, origin_signals.pending_state) AS effective_pending_state,
      theses.* , theses.signal_id AS origin_signal_id
    FROM signal_outcomes outcomes
    JOIN ai_trade_theses theses ON theses.thesis_id = outcomes.thesis_id
    LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
    LEFT JOIN ai_signals origin_signals ON origin_signals.id = outcomes.signal_id
    WHERE outcomes.status IN ('open','closing') AND outcomes.attribution_status <> 'attribution_ambiguous'
      AND theses.status IN ('proposed','active') AND theses.strategy_id = ?
      AND theses.standard_symbol = ?${privateWhere}
      AND ((outcomes.pending_ticket IS NOT NULL
          AND COALESCE(deliveries.pending_state, origin_signals.pending_state) = 'pending')
        OR (outcomes.position_id IS NOT NULL
          AND COALESCE(deliveries.pending_state, origin_signals.pending_state, '') <> 'pending'))
    ORDER BY theses.created_at DESC, outcomes.id DESC`, params)
  const referencePortfolio = market?.strategy_reference_portfolio
  const referenceOutcomeIds = referencePortfolio?.role === 'platform_strategy_reference_portfolio'
    && referencePortfolio?.status !== 'unavailable'
    && Array.isArray(referencePortfolio?.positions)
    && Array.isArray(referencePortfolio?.pending_orders)
    ? new Set([...referencePortfolio.positions, ...referencePortfolio.pending_orders]
      .map(item => /^outcome:(\d+)$/.exec(String(item?.reference_id || ''))?.[1])
      .filter(Boolean).map(Number))
    : null
  const referencePendingByOutcome = referencePortfolio?.role === 'platform_strategy_reference_portfolio'
    && Array.isArray(referencePortfolio?.pending_orders)
    ? new Map(referencePortfolio.pending_orders
      .map(item => [/^outcome:(\d+)$/.exec(String(item?.reference_id || ''))?.[1], item])
      .filter(([id]) => id)
      .map(([id, item]) => [Number(id), {
        valid_until_utc_msc:item?.valid_until_utc_msc ?? null,
        valid_until_utc:item?.valid_until_utc ?? null,
        valid_until_terminal:item?.valid_until_terminal ?? null,
        terminal_timezone_offset_minutes:item?.terminal_timezone_offset_minutes ?? null,
        is_expired:item?.is_expired ?? null,
        remaining_seconds:item?.remaining_seconds ?? null,
        captured_at:item?.captured_at ?? referencePortfolio?.captured_at ?? null,
        captured_at_utc_msc:item?.captured_at_utc_msc ?? referencePortfolio?.captured_at_utc_msc ?? null,
      }]))
    : new Map()
  const groups = new Map()
  for (const rawRow of rows) {
    // The reference portfolio is sourced from the terminal's current
    // positions and pending orders. When it is available, stale database
    // outcomes must not be fed back into a new management inference.
    if (referenceOutcomeIds && !referenceOutcomeIds.has(Number(rawRow.outcome_id))) continue
    const row = normalizePositionManagementOutcome(rawRow)
    if (!isActivePositionManagementOutcome(row)) continue
    if (strategyVersion && Number(row.strategy_version) !== Number(strategyVersion)) continue
    if (!groups.has(row.management_group_id)) {
      const group = { ...publicGroup(row), targets:[] }
      group.frozen_conditions = evaluateFrozenConditions(group.frozen_conditions, market)
      group.pending_order_facts = []
      groups.set(row.management_group_id, group)
    }
    const pendingFact = referencePendingByOutcome.get(Number(row.outcome_id))
    if (pendingFact && row.pending_ticket && !row.position_id) {
      const group = groups.get(row.management_group_id)
      group.pending_order_facts.push(pendingFact)
    }
    groups.get(row.management_group_id).targets.push(row)
  }
  const pendingGroups = []
  const positionGroups = []
  const targets = new Map()
  const asOf = buildPositionManagementAsOf(market, decisionTimeframe)
  const currentBarRef = asOf.closed_bar_time_utc_ms
    ? `bar:${asOf.decision_timeframe}:${asOf.closed_bar_time_utc_ms}` : null
  for (const group of groups.values()) {
    const hasPosition = group.targets.some(row => row.position_id)
    const hasPending = group.targets.some(row => row.pending_ticket && !row.position_id)
    const safe = { ...group }
    delete safe.targets
    safe.allowed_evidence_refs = [...new Set([
      ...(safe.allowed_evidence_refs || []),
      ...(currentBarRef ? [currentBarRef] : []),
    ])]
    if (hasPosition) positionGroups.push(safe)
    if (hasPending) pendingGroups.push(safe)
    targets.set(group.management_group_id, group.targets)
  }
  const context = {
    contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    as_of:asOf,
    pending_groups:pendingGroups,
    position_groups:positionGroups,
  }
  const groupCount = pendingGroups.length + positionGroups.length
  if (groupCount > POSITION_MANAGEMENT_MAX_GROUPS) {
    throw new Error(`position_management_group_limit_exceeded:${groupCount}`)
  }
  const contextChars = JSON.stringify(context).length
  if (contextChars > POSITION_MANAGEMENT_MAX_CONTEXT_CHARS) {
    throw new Error(`position_management_context_budget_exceeded:${contextChars}`)
  }
  Object.defineProperty(context, '_targets', { value:targets, enumerable:false })
  Object.defineProperty(context, '_market', { value:market, enumerable:false })
  Object.defineProperty(context, '_diagnostics', {
    value:{ group_count:groupCount, pending_count:pendingGroups.length,
      position_count:positionGroups.length, context_chars:contextChars },
    enumerable:false,
  })
  return context
}

export function hasActivePositionManagementGroups(context) {
  return Boolean((context?.pending_groups?.length || 0) + (context?.position_groups?.length || 0))
}

export function buildPositionManagementOutputFormat(baseMarketFormat, context) {
  let marketPlan
  try { marketPlan = JSON.parse(baseMarketFormat || '{}') } catch { marketPlan = {} }
  for (const key of ['analysis', 'reasoning', 'position_action', 'pending_action', 'pending_action_reason', 'management_direction', 'cancel_pending']) delete marketPlan[key]
  return JSON.stringify({
    contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    as_of:context.as_of,
    market_regime:'仅允许 bullish | bearish | range | uncertain',
    trade_thesis:'仅允许 continuation | reversal | mean_reversion | breakout',
    market_plan:marketPlan,
    pending_evaluations:(context.pending_groups || []).map(group => ({
      management_group_id:group.management_group_id,
      action:'仅允许 keep | cancel',
      cancel_reason_code:'cancel 时必填，仅允许 expired | thesis_invalidated | risk_reduction | model_judgment；keep 时必须为 null 或 none；expired 只能引用服务端 is_expired=true；thesis_invalidated 只能引用服务端已触发的硬条件',
      reason:'简体中文具体依据',
      evidence_refs:`只能引用：${group.allowed_evidence_refs.join('、') || '空集合'}`,
    })),
    position_evaluations:(context.position_groups || []).map(group => ({
      management_group_id:group.management_group_id,
      thesis_id:group.thesis_id,
      action:'仅允许 hold | exit',
      matched_condition_id:`hold 时为 null；exit 时只能引用：${group.frozen_conditions.map(item => item.condition_id).join('、') || '空集合'}`,
      reversal_candidate:'布尔值，仅为解释性判断，不是执行命令',
      reason:'简体中文说明原交易论点是否失效',
      evidence_refs:`只能引用：${group.allowed_evidence_refs.join('、') || '空集合'}`,
    })),
    analysis:'简体中文行情分析',
    reasoning:'简体中文说明新信号、挂单和持仓三个部分的独立依据',
  }, null, 2)
}

function validateAsOf(value, context) {
  if (String(value?.contract_version || '') !== POSITION_MANAGEMENT_CONTRACT_VERSION) throw new Error('position_management_contract_version_mismatch')
  const asOf = object(value?.as_of)
  if (!asOf) throw new Error('position_management_as_of_required')
  if (String(asOf.decision_timeframe || '').toUpperCase() !== String(context.as_of.decision_timeframe || '').toUpperCase()) {
    throw new Error('position_management_timeframe_mismatch')
  }
  if (Number(asOf.closed_bar_time_utc_ms) !== Number(context.as_of.closed_bar_time_utc_ms)) throw new Error('position_management_closed_bar_mismatch')
  if (String(asOf.market_snapshot_hash || '') !== String(context.as_of.market_snapshot_hash || '')) throw new Error('position_management_snapshot_mismatch')
}

function safeHold(value, marketError) {
  return {
    signal_type:'hold', entry_method:'observe', confidence:0.6,
    position_size_tier:'observe', position_size_reason:'新建仓计划未通过独立校验，本次不增加风险',
    position_action:'observe', pending_action:'none', pending_action_reason:'', management_direction:'none',
    recommended_take_profit_tier:null, analysis:text(value?.analysis, 4000) || '当前不增加新的交易风险。',
    reasoning:text(value?.reasoning, 4000) || '新建仓计划字段不完整，挂单与持仓评估仍按各自校验结果处理。',
    _market_plan_error:marketError,
  }
}

function validateEvidenceRefs(refs, allowed) {
  if (!Array.isArray(refs)) throw new Error('evidence_refs_required')
  const allowedSet = new Set(allowed || [])
  const normalized = [...new Set(refs.map(item => String(item || '').trim()).filter(Boolean))]
  if (!normalized.length || normalized.some(item => !allowedSet.has(item))) throw new Error('evidence_refs_not_allowed')
  return normalized
}

function hasManagementExecutionIntent(item, section) {
  const rawAction = typeof item === 'string' ? item : item?.action
  const action = String(rawAction || '').trim().toLowerCase()
  if (section === 'pending') {
    if (action === 'cancel' || (action && action !== 'keep')) return true
    const rawCancelReasonCode = item?.cancel_reason_code
    const cancelReasonCode = rawCancelReasonCode == null ? '' : String(rawCancelReasonCode).trim().toLowerCase()
    return Boolean(cancelReasonCode && cancelReasonCode !== 'none')
  }
  if (action === 'exit' || (action && action !== 'hold')) return true
  return action === 'hold' && item?.matched_condition_id != null
    && String(item.matched_condition_id).trim() !== ''
}

export function validatePositionManagementResponse(value, context, validateMarketPlan, {
  allowFailClosed = true, allowNonExecutionFailClosed = false,
} = {}) {
  if (!object(value)) throw new Error('position_management_response_not_object')
  validateAsOf(value, context)
  const analysis = text(value.analysis, 4000)
  const reasoning = text(value.reasoning, 4000)
  if (!analysis || !reasoning) throw new Error('position_management_narrative_required')
  const marketRegime = String(value.market_regime || '').toLowerCase()
  const tradeThesis = String(value.trade_thesis || '').toLowerCase()
  if (!['bullish', 'bearish', 'range', 'uncertain'].includes(marketRegime)) throw new Error('position_management_market_regime_invalid')
  if (!['continuation', 'reversal', 'mean_reversion', 'breakout'].includes(tradeThesis)) throw new Error('position_management_trade_thesis_invalid')

  let marketPlan
  let marketError = null
  try {
    const candidate = { ...(object(value.market_plan) || {}), analysis, reasoning,
      position_action:String(value?.market_plan?.signal_type || '').toLowerCase() === 'hold' ? 'observe' : 'open',
      pending_action:'none', pending_action_reason:'', management_direction:'none' }
    marketPlan = validateMarketPlan(candidate)
  } catch (error) {
    marketError = error.message || 'market_plan_invalid'
    marketPlan = safeHold(value, marketError)
  }

  const pendingById = new Map((context.pending_groups || []).map(group => [group.management_group_id, group]))
  const positionById = new Map((context.position_groups || []).map(group => [group.management_group_id, group]))
  const pendingEvaluations = []
  const positionEvaluations = []
  const errors = []
  const seenPending = new Set()
  const seenPosition = new Set()
  const pendingItems = Array.isArray(value.pending_evaluations) ? value.pending_evaluations : []
  const positionItems = Array.isArray(value.position_evaluations) ? value.position_evaluations : []
  const hasExecutionIntent = pendingItems.some(item => hasManagementExecutionIntent(item, 'pending'))
    || positionItems.some(item => hasManagementExecutionIntent(item, 'position'))

  for (const item of pendingItems) {
    try {
      const group = pendingById.get(String(item?.management_group_id || ''))
      if (!group || seenPending.has(group.management_group_id)) throw new Error('pending_management_group_invalid')
      const action = String(item.action || '').toLowerCase()
      if (!['keep', 'cancel'].includes(action)) throw new Error('pending_action_invalid')
      const rawCancelReasonCode = item?.cancel_reason_code
      const hasCancelReasonCode = rawCancelReasonCode !== undefined && rawCancelReasonCode !== null
        && String(rawCancelReasonCode).trim() !== ''
      if (action === 'cancel' && !hasCancelReasonCode) throw new Error('pending_cancel_reason_code_required')
      if (action !== 'cancel' && hasCancelReasonCode
        && String(rawCancelReasonCode).trim().toLowerCase() !== 'none') {
        throw new Error('pending_keep_cancel_reason_code_invalid')
      }
      const cancelReasonCode = action === 'cancel'
        ? String(rawCancelReasonCode).trim().toLowerCase() : null
      if (cancelReasonCode && !['expired', 'thesis_invalidated', 'risk_reduction', 'model_judgment'].includes(cancelReasonCode)) {
        throw new Error('pending_cancel_reason_code_invalid')
      }
      const reason = text(item.reason, 1000)
      if (!reason) throw new Error('pending_reason_required')
      const evidenceRefs = validateEvidenceRefs(item.evidence_refs, group.allowed_evidence_refs)
      const conditionsByRef = new Map((group.frozen_conditions || [])
        .map(condition => [`condition:${condition.condition_id}`, condition]))
      const referencedHard = evidenceRefs
        .map(ref => conditionsByRef.get(ref))
        .filter(condition => condition?.kind === 'hard')
      if (action === 'cancel' && referencedHard.some(condition => condition.evaluation_state === 'not_triggered')) {
        throw new Error('pending_hard_condition_not_triggered')
      }
      if (action === 'cancel' && cancelReasonCode !== 'expired'
        && /(?:过期|到期|超时|expired|timeout)/i.test(reason)) {
        throw new Error('pending_expiry_reason_code_mismatch')
      }
      if (cancelReasonCode === 'expired') {
        const expired = (group.pending_order_facts || []).some(fact => fact?.is_expired === true)
        if (!expired) throw new Error('pending_expired_evidence_required')
      }
      if (action === 'cancel' && cancelReasonCode === 'thesis_invalidated') {
        if (!referencedHard.some(condition => condition.evaluation_state === 'triggered')) {
          throw new Error('pending_thesis_evidence_required')
        }
      }
      seenPending.add(group.management_group_id)
      pendingEvaluations.push({ management_group_id:group.management_group_id, action,
        cancel_reason_code:cancelReasonCode, reason, evidence_refs:evidenceRefs })
    } catch (error) { errors.push({ section:'pending', group_id:item?.management_group_id || null, code:error.message }) }
  }

  for (const item of positionItems) {
    try {
      const group = positionById.get(String(item?.management_group_id || ''))
      if (!group || seenPosition.has(group.management_group_id)) throw new Error('position_management_group_invalid')
      if (String(item.thesis_id || '') !== String(group.thesis_id)) throw new Error('position_thesis_invalid')
      const action = String(item.action || '').toLowerCase()
      if (!['hold', 'exit'].includes(action)) throw new Error('position_action_invalid')
      const allowedConditions = new Set(group.frozen_conditions.map(condition => condition.condition_id))
      const matchedConditionId = item.matched_condition_id == null ? null : String(item.matched_condition_id)
      if (action === 'exit' && (!matchedConditionId || !allowedConditions.has(matchedConditionId))) throw new Error('position_condition_invalid')
      if (action === 'hold' && matchedConditionId !== null) throw new Error('position_hold_condition_must_be_null')
      const reason = text(item.reason, 1000)
      if (!reason) throw new Error('position_reason_required')
      const evidenceRefs = validateEvidenceRefs(item.evidence_refs, group.allowed_evidence_refs)
      seenPosition.add(group.management_group_id)
      positionEvaluations.push({
        management_group_id:group.management_group_id, thesis_id:group.thesis_id, action,
        matched_condition_id:matchedConditionId, reversal_candidate:Boolean(item.reversal_candidate),
        reason, evidence_refs:evidenceRefs,
      })
    } catch (error) { errors.push({ section:'position', group_id:item?.management_group_id || null, code:error.message }) }
  }

  for (const [groupId] of pendingById) if (!seenPending.has(groupId)) {
    errors.push({ section:'pending', group_id:groupId, code:'evaluation_missing' })
    pendingEvaluations.push({
      management_group_id:groupId, action:'keep',
      cancel_reason_code:null,
      reason:'该管理组未通过模型输出校验，服务端按安全默认继续保留挂单',
      evidence_refs:[], validation_source:'server_fail_closed',
    })
  }
  for (const [groupId, group] of positionById) if (!seenPosition.has(groupId)) {
    errors.push({ section:'position', group_id:groupId, code:'evaluation_missing' })
    positionEvaluations.push({
      management_group_id:groupId, thesis_id:group.thesis_id, action:'hold',
      matched_condition_id:null, reversal_candidate:false,
      reason:'该管理组未通过模型输出校验，服务端按安全默认继续持有',
      evidence_refs:[], validation_source:'server_fail_closed',
    })
  }

  const nonExecutionMarketPlan = String(marketPlan?.signal_type || '').toLowerCase() === 'hold'
    && String(marketPlan?.entry_method || '').toLowerCase() === 'observe'
  const requiresRepair = Boolean(marketError
    || (errors.length && (!nonExecutionMarketPlan || hasExecutionIntent)))
  if (!allowFailClosed && (marketError || errors.length)
    && !(allowNonExecutionFailClosed && !requiresRepair)) {
    const details = [
      ...(marketError ? [`market:${marketError}`] : []),
      ...errors.map(error => `${error.section}:${error.group_id || 'unknown'}:${error.code}`),
    ]
    throw new Error(`position_management_output_invalid:${details.join('|')}`)
  }

  return {
    ...marketPlan,
    market_regime:marketRegime,
    trade_thesis:tradeThesis,
    _position_management:{
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:{ ...context.as_of },
      pending_evaluations:pendingEvaluations,
      position_evaluations:positionEvaluations,
      validation:{ market_plan:marketError ? 'invalid' : 'valid', errors },
    },
  }
}

function taskSummary(action, taskType) {
  if (taskType === 'pending_cancel') return action === 'cancel'
    ? 'AI 明确建议取消策略挂单，已进入挂单身份与状态校验' : '策略挂单继续保留'
  return action === 'exit' ? 'AI 提出平掉策略持仓，当前仅记录并复核' : '原交易论点仍有效，继续持有'
}

async function resolveModes(targets) {
  const control = await queryOne(`SELECT maximum_mode, ai_pending_cancel_enabled
    FROM global_position_management_control WHERE id = 1`)
  const unique = [...new Set(targets.map(row => Number(row.user_id)).filter(id => id > 0))]
  const rows = unique.length ? await queryAll(`SELECT user_id, execution_mode FROM user_position_management_settings
    WHERE user_id IN (${unique.map(() => '?').join(',')})`, unique) : []
  const byUser = new Map(rows.map(row => [Number(row.user_id), normalizeMode(row.execution_mode)]))
  return { control:control || { maximum_mode:'display', ai_pending_cancel_enabled:0 }, byUser }
}

export function resolveAutomaticExitConfirmation(current, previous = null) {
  const validationStatus = current?.validation_source === 'server_fail_closed' ? 'invalid' : 'valid'
  const action = String(current?.action || '').toLowerCase()
  if (validationStatus !== 'valid') {
    return { validation_status:'invalid', confirmation_count:0, reset_reason:'invalid_inference_output' }
  }
  if (action !== 'exit') {
    return { validation_status:'valid', confirmation_count:0, reset_reason:'automatic_inference_hold' }
  }
  const previousExit = String(previous?.validation_status || '').toLowerCase() === 'valid'
    && String(previous?.action || '').toLowerCase() === 'exit'
  return {
    validation_status:'valid',
    confirmation_count:previousExit ? AUTO_EXIT_CONFIRMATIONS_REQUIRED : 1,
    reset_reason:null,
  }
}

async function recordAutomaticPositionEvaluation({ signalId, context, target, evaluation, inferenceSource } = {}) {
  const now = beijingNow()
  const originalSymbol = String(target.original_symbol || target.symbol || target.standard_symbol || '')
  const standardSymbol = target.standard_symbol || stripBrokerSuffix(originalSymbol).toUpperCase()
  const validationStatus = evaluation.validation_source === 'server_fail_closed' ? 'invalid' : 'valid'
  const result = await queryRun(`INSERT IGNORE INTO ai_position_management_evaluations
    (decision_signal_id, user_id, trading_account_id, outcome_id, position_id,
     management_group_id, thesis_id, original_symbol, standard_symbol, action,
     validation_status, matched_condition_id, reason, evidence_refs_json,
     model_evaluation_json, decision_timeframe, closed_bar_time_utc_ms,
     market_snapshot_hash, inference_source, consecutive_exit_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, [
    signalId, target.user_id, target.trading_account_id, target.outcome_id,
    target.position_id || null, target.management_group_id, target.thesis_id,
    originalSymbol, standardSymbol, evaluation.action, validationStatus,
    evaluation.matched_condition_id || null, text(evaluation.reason, 1000) || null,
    JSON.stringify(evaluation.evidence_refs || []), JSON.stringify(evaluation),
    context.as_of.decision_timeframe, context.as_of.closed_bar_time_utc_ms,
    String(context.as_of.market_snapshot_hash).replace(/^sha256:/, ''), inferenceSource, now,
  ])
  if (!Number(result?.insertId)) return null
  const evaluationId = Number(result.insertId)
  const previous = inferenceSource === 'automatic_scheduler'
    ? await queryOne(`SELECT id, decision_signal_id, action, validation_status,
        consecutive_exit_count, created_at
      FROM ai_position_management_evaluations
      WHERE outcome_id = ? AND management_group_id = ? AND inference_source = 'automatic_scheduler' AND id < ?
      ORDER BY id DESC LIMIT 1`, [target.outcome_id, target.management_group_id, evaluationId])
    : null
  const confirmation = inferenceSource === 'automatic_scheduler'
    ? resolveAutomaticExitConfirmation(evaluation, previous)
    : { validation_status:validationStatus, confirmation_count:0, reset_reason:null }
  await queryRun(`UPDATE ai_position_management_evaluations
    SET consecutive_exit_count = ? WHERE id = ?`, [confirmation.confirmation_count, evaluationId])
  return {
    id:evaluationId,
    decision_signal_id:Number(signalId),
    action:String(evaluation.action || '').toLowerCase(),
    validation_status:confirmation.validation_status,
    confirmation_count:confirmation.confirmation_count,
    reset_reason:confirmation.reset_reason,
    inference_source:inferenceSource,
    previous,
    created_at:now,
  }
}

function automaticInferenceEvidence(record) {
  const previous = record.previous && String(record.previous.action).toLowerCase() === 'exit'
    && String(record.previous.validation_status).toLowerCase() === 'valid' ? record.previous : null
  const evaluationIds = [previous?.id, record.id].filter(Boolean).map(Number)
  const decisionSignalIds = [previous?.decision_signal_id, record.decision_signal_id].filter(Boolean).map(Number)
  return {
    status:record.confirmation_count >= AUTO_EXIT_CONFIRMATIONS_REQUIRED ? 'confirmed' : 'candidate',
    source:'automatic_inference_consecutive',
    confirmation_count:record.confirmation_count,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    evaluation_ids:evaluationIds,
    decision_signal_ids:decisionSignalIds,
    latest_evaluation_id:record.id,
    latest_decision_signal_id:record.decision_signal_id,
  }
}

async function resetAutomaticExitCandidate(target, record, evaluation) {
  const task = await queryOne(`SELECT * FROM ai_position_management_tasks
    WHERE outcome_id = ? AND management_group_id = ? AND task_type = 'position_exit'
      AND status = 'CANDIDATE'
    ORDER BY id DESC LIMIT 1`, [target.outcome_id, target.management_group_id])
  if (!task) return null
  const now = beijingNow()
  const previousEvidence = json(task.evidence_validation_json, {})
  const evaluationIds = [...new Set([
    ...(Array.isArray(previousEvidence.evaluation_ids) ? previousEvidence.evaluation_ids : []),
    record.id,
  ].map(Number).filter(id => id > 0))]
  const decisionSignalIds = [...new Set([
    ...(Array.isArray(previousEvidence.decision_signal_ids) ? previousEvidence.decision_signal_ids : []),
    record.decision_signal_id,
  ].map(Number).filter(id => id > 0))]
  const evidence = {
    status:'reset',
    source:record.validation_status === 'invalid' ? 'invalid_inference_output' : 'automatic_inference_hold',
    confirmation_count:0,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    reset_evaluation_id:record.id,
    reset_decision_signal_id:record.decision_signal_id,
    evaluation_ids:evaluationIds,
    decision_signal_ids:decisionSignalIds,
  }
  const result = await queryRun(`UPDATE ai_position_management_tasks
    SET status = 'HELD', evidence_validation_json = ?, confirmation_count = 0,
      state_version = state_version + 1, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'CANDIDATE'`, [JSON.stringify(evidence), now, now, task.id])
  if (Number(result?.changes ?? result?.affectedRows ?? 0) !== 1) return null
  const summary = record.validation_status === 'invalid'
    ? '本轮自动推理结果无效，连续平仓确认已中断'
    : '本轮自动推理建议继续持有，连续平仓确认已清零'
  await queryRun(`INSERT INTO ai_position_management_events
    (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
    VALUES (?, 'CANDIDATE', 'HELD', 'automatic_confirmation_reset', ?, ?, 'model', ?)`, [
    task.id, summary, JSON.stringify({ evaluation, evidence }), now,
  ])
  const updated = { ...task, status:'HELD', state_version:Number(task.state_version || 1) + 1,
    confirmation_count:0, evidence_validation_json:JSON.stringify(evidence), updated_at:now }
  broadcastPositionManagementTask(updated, 'automatic_confirmation_reset')
  return updated
}

async function createAutomaticExitTask({ signalId, context, target, evaluation, mode, record, evidence } = {}) {
  const now = beijingNow()
  const originalSymbol = String(target.original_symbol || target.symbol || target.standard_symbol || '')
  const confirmed = record.confirmation_count >= AUTO_EXIT_CONFIRMATIONS_REQUIRED
  const status = confirmed ? 'EVIDENCE_CONFIRMED' : 'CANDIDATE'
  const taskKey = hash(['automatic_inference_exit', target.outcome_id, target.management_group_id,
    evidence.evaluation_ids[0] || record.id])
  const result = await queryRun(`INSERT IGNORE INTO ai_position_management_tasks
    (task_key, task_type, execution_mode, user_id, trading_account_id, ownership_history_id,
     broker_server_key, login_account, bridge_generation, original_symbol, standard_symbol,
     strategy_id, strategy_version, management_group_id, thesis_id, origin_signal_id,
     decision_signal_id, outcome_id, decision_timeframe, closed_bar_time_utc_ms,
     market_snapshot_hash, candidate_action, reversal_candidate, model_evaluation_json,
     evidence_validation_json, confirmation_count, required_confirmations, status,
     state_version, candidate_expires_at, created_at, updated_at)
    VALUES (?, 'position_exit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, 'exit', ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), ?, ?)`, [
    taskKey, mode, target.user_id, target.trading_account_id, target.ownership_history_id || null,
    target.broker_server_key || null, target.login_account || null, getBridgeGeneration(Number(target.user_id)),
    originalSymbol, target.standard_symbol || stripBrokerSuffix(originalSymbol).toUpperCase(), target.strategy_id,
    target.strategy_version || 1, target.management_group_id, target.thesis_id,
    target.origin_signal_id || null, signalId, target.outcome_id, context.as_of.decision_timeframe,
    context.as_of.closed_bar_time_utc_ms, String(context.as_of.market_snapshot_hash).replace(/^sha256:/, ''),
    evaluation.reversal_candidate ? 1 : 0, JSON.stringify(evaluation), JSON.stringify(evidence),
    record.confirmation_count, AUTO_EXIT_CONFIRMATIONS_REQUIRED, status, confirmed ? 2 : 1, now, now,
  ])
  if (!Number(result?.insertId)) return null
  const taskId = Number(result.insertId)
  await queryRun(`INSERT INTO ai_position_management_events
    (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
    VALUES (?, NULL, ?, 'automatic_confirmation_recorded', ?, ?, 'model', ?)`, [
    taskId, status,
    confirmed ? '连续两轮自动推理均建议平仓，已进入自动执行队列' : '第 1 次自动推理建议平仓，等待下一轮确认',
    JSON.stringify({ mode, evaluation, evidence }), now,
  ])
  const task = { id:taskId, user_id:Number(target.user_id), status, state_version:confirmed ? 2 : 1,
    execution_mode:mode, task_type:'position_exit', management_group_id:target.management_group_id,
    thesis_id:target.thesis_id, candidate_action:'exit', confirmation_count:record.confirmation_count,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED, updated_at:now }
  broadcastPositionManagementTask(task, confirmed ? 'automatic_confirmation_completed' : 'automatic_confirmation_recorded')
  return task
}

async function advanceAutomaticExitCandidate({ signalId, context, target, evaluation, mode, record } = {}) {
  const evidence = automaticInferenceEvidence(record)
  const task = await queryOne(`SELECT * FROM ai_position_management_tasks
    WHERE outcome_id = ? AND management_group_id = ? AND task_type = 'position_exit'
      AND status NOT IN ('HELD','EXPIRED','REJECTED','FAILED','COMPLETED','EXIT_ONLY_COMPLETED','MANUAL_REVIEW')
    ORDER BY id DESC LIMIT 1`, [target.outcome_id, target.management_group_id])
  if (task && task.status !== 'CANDIDATE') return null
  if (record.confirmation_count < AUTO_EXIT_CONFIRMATIONS_REQUIRED) {
    return task ? null : createAutomaticExitTask({ signalId, context, target, evaluation, mode, record, evidence })
  }
  if (!task) return createAutomaticExitTask({ signalId, context, target, evaluation, mode, record, evidence })
  const now = beijingNow()
  const result = await queryRun(`UPDATE ai_position_management_tasks
    SET decision_signal_id = ?, closed_bar_time_utc_ms = ?, market_snapshot_hash = ?,
      reversal_candidate = ?, model_evaluation_json = ?, evidence_validation_json = ?,
      confirmation_count = ?, required_confirmations = ?, status = 'EVIDENCE_CONFIRMED',
      state_version = state_version + 1, updated_at = ?
    WHERE id = ? AND status = 'CANDIDATE'`, [
    signalId, context.as_of.closed_bar_time_utc_ms,
    String(context.as_of.market_snapshot_hash).replace(/^sha256:/, ''),
    evaluation.reversal_candidate ? 1 : 0, JSON.stringify(evaluation), JSON.stringify(evidence),
    AUTO_EXIT_CONFIRMATIONS_REQUIRED, AUTO_EXIT_CONFIRMATIONS_REQUIRED, now, task.id,
  ])
  if (Number(result?.changes ?? result?.affectedRows ?? 0) !== 1) return null
  await queryRun(`INSERT INTO ai_position_management_events
    (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
    VALUES (?, 'CANDIDATE', 'EVIDENCE_CONFIRMED', 'automatic_confirmation_completed',
      '连续两轮自动推理均建议平仓，已进入自动执行队列', ?, 'model', ?)`, [
    task.id, JSON.stringify({ evaluation, evidence }), now,
  ])
  const updated = { ...task, status:'EVIDENCE_CONFIRMED', state_version:Number(task.state_version || 1) + 1,
    decision_signal_id:signalId, model_evaluation_json:JSON.stringify(evaluation),
    evidence_validation_json:JSON.stringify(evidence), confirmation_count:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED, updated_at:now }
  broadcastPositionManagementTask(updated, 'automatic_confirmation_completed')
  return updated
}

export async function persistPositionManagementEvaluations({
  signalId, context, management, inferenceSource = 'manual_analysis', synchronousPendingCancelGroupIds = null,
} = {}) {
  if (!signalId || !context?._targets || !management) return []
  const positionEvaluations = management.position_evaluations || []
  const synchronousGroups = synchronousPendingCancelGroupIds instanceof Set
    ? synchronousPendingCancelGroupIds
    : new Set(Array.isArray(synchronousPendingCancelGroupIds) ? synchronousPendingCancelGroupIds : [])
  const pendingCandidates = (management.pending_evaluations || [])
    .filter(item => item.action === 'cancel'
      && !synchronousGroups.has(String(item?.management_group_id || '')))
    .map(item => ({ ...item, taskType:'pending_cancel' }))
  const allTargets = [
    ...positionEvaluations.flatMap(item => (context._targets.get(item.management_group_id) || [])
      .filter(target => targetMatchesPositionManagementTask(target, 'position_exit'))),
    ...pendingCandidates.flatMap(item => (context._targets.get(item.management_group_id) || [])
      .filter(target => targetMatchesPositionManagementTask(target, 'pending_cancel'))),
  ]
  const modes = await resolveModes(allTargets)
  const created = []

  for (const evaluation of positionEvaluations) {
    const targets = (context._targets.get(evaluation.management_group_id) || [])
      .filter(target => targetMatchesPositionManagementTask(target, 'position_exit'))
    for (const target of targets) {
      const mode = resolvePositionManagementTaskMode('position_exit',
        modes.byUser.get(Number(target.user_id)) || 'auto_exit', modes.control)
      if (mode === 'display') continue
      const record = await recordAutomaticPositionEvaluation({
        signalId, context, target, evaluation, inferenceSource,
      })
      if (!record) continue
      if (inferenceSource !== 'automatic_scheduler') continue
      const task = record.validation_status !== 'valid' || record.action !== 'exit'
        ? await resetAutomaticExitCandidate(target, record, evaluation)
        : await advanceAutomaticExitCandidate({ signalId, context, target, evaluation, mode, record })
      if (task) created.push(task)
    }
  }

  for (const evaluation of pendingCandidates) {
    const targets = (context._targets.get(evaluation.management_group_id) || [])
      .filter(target => targetMatchesPositionManagementTask(target, evaluation.taskType))
    for (const target of targets) {
      const mode = resolvePositionManagementTaskMode(
        evaluation.taskType,
        modes.byUser.get(Number(target.user_id)) || 'auto_exit',
        modes.control,
      )
      if (mode === 'display') continue
      const originalSymbol = String(target.original_symbol || target.symbol || target.standard_symbol || '')
      const taskKey = hash([
        target.ownership_history_id, target.strategy_id, target.thesis_id, target.management_group_id,
        context.as_of.closed_bar_time_utc_ms, evaluation.action, target.outcome_id,
      ])
      const evidenceValidation = {
        status:'confirmed', source:'single_inference_pending_cancel',
        confirmation_count:1, required_confirmations:1,
        closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms,
      }
      const now = beijingNow()
      const result = await queryRun(`INSERT IGNORE INTO ai_position_management_tasks
        (task_key, task_type, execution_mode, user_id, trading_account_id, ownership_history_id,
         broker_server_key, login_account, bridge_generation, original_symbol, standard_symbol,
         strategy_id, strategy_version, management_group_id, thesis_id, origin_signal_id,
         decision_signal_id, outcome_id, decision_timeframe, closed_bar_time_utc_ms,
         market_snapshot_hash, candidate_action, reversal_candidate, model_evaluation_json,
         evidence_validation_json, confirmation_count, required_confirmations,
         status, state_version, candidate_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          1, 1, 'EVIDENCE_CONFIRMED', 1, DATE_ADD(NOW(), INTERVAL 1 DAY), ?, ?)`, [
        taskKey, evaluation.taskType, mode, target.user_id, target.trading_account_id,
        target.ownership_history_id || null, target.broker_server_key || null, target.login_account || null,
        getBridgeGeneration(Number(target.user_id)), originalSymbol,
        target.standard_symbol || stripBrokerSuffix(originalSymbol).toUpperCase(), target.strategy_id,
        target.strategy_version || 1, target.management_group_id, target.thesis_id,
        target.origin_signal_id || null, signalId, target.outcome_id, context.as_of.decision_timeframe,
        context.as_of.closed_bar_time_utc_ms, String(context.as_of.market_snapshot_hash).replace(/^sha256:/, ''),
        evaluation.action, evaluation.reversal_candidate ? 1 : 0, JSON.stringify(evaluation),
        JSON.stringify(evidenceValidation), now, now,
      ])
      if (!Number(result?.insertId)) continue
      const taskId = Number(result.insertId)
      await queryRun(`INSERT INTO ai_position_management_events
        (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
        VALUES (?, NULL, 'EVIDENCE_CONFIRMED', 'single_inference_pending_cancel_confirmed', ?, ?, 'model', ?)`, [
        taskId, taskSummary(evaluation.action, evaluation.taskType),
        JSON.stringify({ mode, evaluation, evidence:evidenceValidation }), now,
      ])
      const task = { id:taskId, user_id:Number(target.user_id), status:'EVIDENCE_CONFIRMED', state_version:1, execution_mode:mode,
        task_type:evaluation.taskType, management_group_id:target.management_group_id,
        thesis_id:target.thesis_id, candidate_action:evaluation.action,
        confirmation_count:1, required_confirmations:1, updated_at:now }
      created.push(task)
      broadcastPositionManagementTask(task, 'single_inference_pending_cancel_confirmed')
    }
  }
  return created
}

export function canTransitionPositionManagement(fromStatus, toStatus) {
  if (TERMINAL_STATES.has(String(fromStatus || ''))) return false
  return (TRANSITIONS.get(String(fromStatus || '')) || []).includes(String(toStatus || ''))
}

export async function transitionPositionManagementTask({
  taskId, expectedStateVersion, expectedFencingToken, toStatus, eventType,
  summary, details = {}, actorType = 'system', actorUserId = null,
} = {}) {
  const result = await withTransaction(async run => {
    const [rows] = await run('SELECT * FROM ai_position_management_tasks WHERE id = ? FOR UPDATE', [taskId])
    const task = Array.isArray(rows) ? rows[0] : null
    if (!task) throw new Error('position_management_task_not_found')
    if (Number(task.state_version) !== Number(expectedStateVersion)) throw new Error('position_management_state_version_conflict')
    if (Number(task.fencing_token) !== Number(expectedFencingToken)) throw new Error('position_management_fencing_conflict')
    if (!canTransitionPositionManagement(task.status, toStatus)) {
      const error = new Error('position_management_transition_invalid')
      error.fromStatus = String(task.status || '')
      error.toStatus = String(toStatus || '')
      throw error
    }
    const now = beijingNow()
    const terminal = TERMINAL_STATES.has(toStatus)
    const [updated] = await run(`UPDATE ai_position_management_tasks SET status = ?, state_version = state_version + 1,
      completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ?
      WHERE id = ? AND state_version = ? AND fencing_token = ?`, [
      toStatus, terminal ? 1 : 0, now, now, taskId, expectedStateVersion, expectedFencingToken,
    ])
    if (Number(updated?.affectedRows || 0) !== 1) throw new Error('position_management_transition_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      taskId, task.status, toStatus, eventType || 'state_changed', text(summary, 500) || '持仓管理状态已更新',
      JSON.stringify(details || {}), actorType, actorUserId || null, now,
    ])
    return { ...task, status:toStatus, state_version:Number(task.state_version) + 1, updated_at:now }
  })
  broadcastPositionManagementTask(result, eventType || 'state_changed')
  return result
}

export async function claimPositionManagementLease(taskId, leaseSeconds = 45) {
  const leaseToken = crypto.randomUUID()
  const seconds = Math.max(10, Math.min(Number(leaseSeconds) || 45, 300))
  const result = await queryRun(`UPDATE ai_position_management_tasks
    SET lease_token = ?, lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
      fencing_token = fencing_token + 1, updated_at = ?
    WHERE id = ? AND status NOT IN ('HELD','EXPIRED','REJECTED','FAILED','COMPLETED','EXIT_ONLY_COMPLETED')
      AND (lease_token IS NULL OR lease_expires_at < NOW())`, [leaseToken, seconds, beijingNow(), taskId])
  if (Number(result?.changes ?? result?.affectedRows ?? 0) !== 1) return null
  return queryOne(`SELECT id, lease_token, lease_expires_at, fencing_token, state_version, status
    FROM ai_position_management_tasks WHERE id = ?`, [taskId])
}

export async function createPositionManagementCommand({ taskId, commandType, commandSequence, expectedState, request } = {}) {
  const sequence = Math.max(1, Number(commandSequence) || 1)
  const operationId = `PM-${taskId}-${commandType}-${sequence}`
  const now = beijingNow()
  const expectedPayload = expectedState || {}
  const requestPayload = request || {}
  await withTransaction(async run => {
    const [rows] = await run(`SELECT * FROM ai_position_management_commands
      WHERE task_id = ? AND command_type = ? AND command_sequence = ? FOR UPDATE`,
    [taskId, commandType, sequence])
    let existing = rows?.[0] || null
    if (!existing) {
      const [operationRows] = await run(`SELECT * FROM ai_position_management_commands
        WHERE operation_id = ? FOR UPDATE`, [operationId])
      if (operationRows?.length) throw new Error('position_management_command_payload_conflict')
    }
    if (existing) {
      let storedExpected = null
      let storedRequest = null
      try {
        storedExpected = JSON.parse(existing.expected_state_json || '{}')
        storedRequest = JSON.parse(existing.request_json || '{}')
      } catch {
        throw new Error('position_management_command_payload_conflict')
      }
      if (existing.operation_id !== operationId || existing.command_type !== commandType
        || Number(existing.command_sequence) !== sequence
        || !sameJsonPayload(storedExpected, expectedPayload)
        || !sameJsonPayload(storedRequest, requestPayload)) {
        throw new Error('position_management_command_payload_conflict')
      }
      if (existing.send_status !== 'prepared' || existing.bridge_command_id) {
        throw new Error('position_management_command_already_sent')
      }
      return
    }
    await run(`INSERT INTO ai_position_management_commands
      (task_id, command_sequence, operation_id, command_type, expected_state_json, request_json,
       send_status, reconciliation_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'prepared', 'pending', ?, ?)`, [
      taskId, sequence, operationId, commandType, JSON.stringify(expectedPayload), JSON.stringify(requestPayload), now, now,
    ])
  })
  return queryOne('SELECT * FROM ai_position_management_commands WHERE operation_id = ?', [operationId])
}

export async function getPositionManagementSettings(userId) {
  const [setting, control] = await Promise.all([
    queryOne('SELECT * FROM user_position_management_settings WHERE user_id = ?', [userId]),
    queryOne('SELECT * FROM global_position_management_control WHERE id = 1'),
  ])
  const requested = normalizeMode(setting?.execution_mode || 'auto_exit', 'auto_exit')
  return {
    user:{ user_id:Number(userId), execution_mode:requested },
    platform:{ ...(control || { maximum_mode:'display', ai_pending_order_enabled:0, ai_pending_cancel_enabled:0 }),
      maximum_mode:normalizeMode(control?.maximum_mode || 'display') },
    effective_mode:effectiveMode(requested, control?.maximum_mode || 'display'),
    capabilities:{
      evaluation_enabled:true,
      worker_installed:true,
      exit_only_ready:true,
      pending_cancel_ready:true,
      pending_cancel_enabled:Number(control?.ai_pending_cancel_enabled ?? 0) === 1,
      auto_reverse_ready:false,
      automatic_execution_ready:true,
      formal_enable_available:true,
      reason:'自动平仓、AI 挂单和 AI 取消挂单使用三项独立平台开关；用户自动平仓默认开启并保留个人选择',
    },
  }
}

export async function getPositionManagementAdminSettings() {
  const control = await queryOne('SELECT * FROM global_position_management_control WHERE id = 1')
  return {
    platform:{ ...(control || { maximum_mode:'display', ai_pending_order_enabled:0, ai_pending_cancel_enabled:0 }),
      maximum_mode:normalizeMode(control?.maximum_mode || 'display') },
    capabilities:{
      evaluation_enabled:true, worker_installed:true, exit_only_ready:true,
      pending_cancel_ready:true, auto_reverse_ready:false,
      automatic_execution_ready:true, formal_enable_available:true,
      reason:'自动平仓、AI 挂单和 AI 取消挂单均已接入独立平台开关与对应安全链路。',
    },
  }
}

export async function saveGlobalPositionManagementControl(actorUserId, input = {}) {
  if (String(input.maximum_mode || '').toLowerCase() === 'shadow') throw new Error('position_management_mode_invalid')
  const maximumMode = normalizeMode(input.maximum_mode, '')
  if (!['display', 'auto_exit'].includes(maximumMode)) {
    throw new Error(maximumMode === 'auto_reverse' ? 'position_management_auto_reverse_not_ready' : 'position_management_mode_invalid')
  }
  const reason = text(input.reason, 1000)
  const current = await queryOne(`SELECT maximum_mode, ai_pending_order_enabled, ai_pending_cancel_enabled
    FROM global_position_management_control WHERE id = 1`)
  if (maximumMode === 'auto_exit' && normalizeMode(current?.maximum_mode || 'display') !== 'auto_exit' && reason.length < 4) {
    throw new Error('position_management_enable_reason_required')
  }
  const pendingOrderEnabled = input.ai_pending_order_enabled == null
    ? Number(current?.ai_pending_order_enabled ?? 1) === 1 : Boolean(input.ai_pending_order_enabled)
  const pendingCancelEnabled = input.ai_pending_cancel_enabled == null
    ? Number(current?.ai_pending_cancel_enabled ?? 1) === 1 : Boolean(input.ai_pending_cancel_enabled)
  await queryRun(`UPDATE global_position_management_control
    SET maximum_mode = ?, ai_pending_order_enabled = ?, ai_pending_cancel_enabled = ?,
      changed_by = ?, reason = ?, updated_at = ?
    WHERE id = 1`, [maximumMode, pendingOrderEnabled ? 1 : 0,
    pendingCancelEnabled ? 1 : 0, actorUserId, reason || null, beijingNow()])
  broadcastAdminEvent('ai-operations', 'position_management_control_updated', {
    maximum_mode:maximumMode,
    ai_pending_order_enabled:pendingOrderEnabled,
    ai_pending_cancel_enabled:pendingCancelEnabled,
  }, { scopes:['ai-operations', 'risk-audit'], refresh:true })
  return getPositionManagementAdminSettings()
}

export async function savePositionManagementSettings(userId, input = {}) {
  if (String(input.execution_mode || '').toLowerCase() === 'shadow') throw new Error('position_management_mode_invalid')
  const mode = normalizeMode(input.execution_mode, '')
  if (!['display', 'auto_exit'].includes(mode)) throw new Error('position_management_mode_invalid')
  await queryRun(`INSERT INTO user_position_management_settings
    (user_id, execution_mode, auto_exit_daily_limit, auto_reverse_daily_limit, cooldown_minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE execution_mode = VALUES(execution_mode),
      updated_at = VALUES(updated_at)`, [
    userId, mode, 0, 0, 60, beijingNow(),
  ])
  sendToBrowsers(Number(userId), { type:'position_management_settings_updated', refresh:true })
  broadcastAdminEvent('ai-operations', 'position_management_settings_updated', {
    user_id:Number(userId), execution_mode:mode,
  }, { scopes:['ai-operations', 'risk-audit'], refresh:true })
  return getPositionManagementSettings(userId)
}

export async function listPositionManagementTasks({ userId = null, admin = false, status = null, page = 1, pageSize = 20 } = {}) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeSize = Math.max(1, Math.min(Number(pageSize) || 20, 100))
  const where = []
  const params = []
  if (!admin) { where.push('tasks.user_id = ?'); params.push(Number(userId)) }
  if (status) { where.push('tasks.status = ?'); params.push(String(status).toUpperCase()) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM ai_position_management_tasks tasks ${clause}`, params)
  const total = Number(totalRow?.total || 0)
  const pages = Math.max(1, Math.ceil(total / safeSize))
  const normalizedPage = Math.min(safePage, pages)
  const rows = await queryAll(`SELECT tasks.*, users.nickname AS user_nickname, users.email AS user_email,
      outcomes.position_id AS target_position_id, outcomes.pending_ticket AS target_pending_ticket,
      outcomes.entry_direction AS target_direction, outcomes.expected_volume AS target_volume,
      outcomes.status AS target_status
    FROM ai_position_management_tasks tasks
    LEFT JOIN users ON users.id = tasks.user_id
    LEFT JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
    ${clause} ORDER BY tasks.id DESC LIMIT ? OFFSET ?`, [...params, safeSize, (normalizedPage - 1) * safeSize])
  return { tasks:rows, pagination:{ page:normalizedPage, page_size:safeSize, total, pages } }
}

export async function getPositionManagementTask(taskId, { userId = null, admin = false } = {}) {
  const task = await queryOne(`SELECT tasks.*,
      outcomes.position_id AS target_position_id, outcomes.pending_ticket AS target_pending_ticket,
      outcomes.entry_direction AS target_direction, outcomes.expected_volume AS target_expected_volume,
      outcomes.entry_volume AS target_entry_volume, outcomes.closed_volume AS target_closed_volume,
      outcomes.status AS target_status, outcomes.attribution_status AS target_attribution_status,
      outcomes.actual_stop_loss AS target_actual_stop_loss,
      outcomes.actual_take_profit AS target_actual_take_profit,
      outcomes.last_position_snapshot_json AS target_snapshot_json,
      theses.core_entry_reason, theses.invalidation_conditions_json
    FROM ai_position_management_tasks tasks
    LEFT JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
    LEFT JOIN ai_trade_theses theses ON theses.thesis_id = tasks.thesis_id
    WHERE tasks.id = ?${admin ? '' : ' AND tasks.user_id = ?'}`,
    admin ? [taskId] : [taskId, userId])
  if (!task) return null
  const evidence = json(task.evidence_validation_json, {})
  const evaluationIds = Array.isArray(evidence.evaluation_ids)
    ? [...new Set(evidence.evaluation_ids.map(Number).filter(id => id > 0))] : []
  const [events, commands, evaluations] = await Promise.all([
    queryAll('SELECT * FROM ai_position_management_events WHERE task_id = ? ORDER BY id', [taskId]),
    queryAll('SELECT * FROM ai_position_management_commands WHERE task_id = ? ORDER BY command_sequence, id', [taskId]),
    evaluationIds.length ? queryAll(`SELECT * FROM ai_position_management_evaluations
      WHERE id IN (${evaluationIds.map(() => '?').join(',')}) ORDER BY id`, evaluationIds) : [],
  ])
  return { task, events, commands, evaluations }
}

export function broadcastPositionManagementTask(task, reason = 'updated') {
  const payload = { type:'position_management_task_updated', reason, task:{
    id:Number(task.id), status:task.status, state_version:Number(task.state_version || 1),
    execution_mode:task.execution_mode, task_type:task.task_type,
    management_group_id:task.management_group_id, thesis_id:task.thesis_id,
    candidate_action:task.candidate_action, updated_at:task.updated_at || beijingNow(),
  } }
  sendToBrowsers(Number(task.user_id), payload)
  broadcastAdminEvent('risk-audit', 'position_management_task_updated', {
    user_id:Number(task.user_id), ...payload.task,
  }, { scopes:['ai-operations', 'risk-audit'], refresh:true })
}

export function positionProtectionStatus(position, direction = null) {
  const side = normalizeDirection(direction || position?.type)
  const current = number(position?.price_current ?? position?.current_price)
  const stopLoss = number(position?.sl)
  const takeProfit = number(position?.tp)
  let status = 'unknown'
  if (side && current && current > 0) {
    if (!stopLoss || stopLoss <= 0) status = 'missing_stop_loss'
    else if ((side === 'buy' && stopLoss >= current) || (side === 'sell' && stopLoss <= current)) status = 'invalid_stop_loss_direction'
    else status = 'protected'
  }
  return { status, actualStopLoss:stopLoss && stopLoss > 0 ? stopLoss : null,
    actualTakeProfit:takeProfit && takeProfit > 0 ? takeProfit : null,
    systemOwned:Number(position?.magic || 0) === SYSTEM_MAGIC }
}
