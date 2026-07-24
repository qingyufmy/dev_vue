import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { broadcastAdminEvent, getBridgeGeneration, sendToBrowsers } from '../../bridge-ws.js'
import { stripBrokerSuffix } from './utils.js'

export const POSITION_MANAGEMENT_CONTRACT_VERSION = 'position-management-v1.1'
export const POSITION_MANAGEMENT_MODES = ['display', 'auto_exit', 'auto_reverse']
export const POSITION_MANAGEMENT_MAX_GROUPS = 20
export const POSITION_MANAGEMENT_MAX_CONTEXT_CHARS = 32_000

const SYSTEM_MAGIC = 234000
const MODE_RANK = new Map(POSITION_MANAGEMENT_MODES.map((mode, index) => [mode, index]))
const TERMINAL_STATES = new Set(['HELD', 'EXPIRED', 'REJECTED', 'FAILED', 'COMPLETED', 'EXIT_ONLY_COMPLETED'])
const TRANSITIONS = new Map(Object.entries({
  CANDIDATE:['EVIDENCE_CONFIRMED', 'HELD', 'EXPIRED', 'REJECTED'],
  EVIDENCE_CONFIRMED:['PRECONDITIONS_LOCKED', 'EXPIRED', 'REJECTED'],
  PRECONDITIONS_LOCKED:['PENDING_CANCEL_INTENT', 'CLOSE_INTENT_CREATED', 'COMPLETED', 'REJECTED'],
  PENDING_CANCEL_INTENT:['PENDING_CANCEL_SENT', 'FAILED'],
  PENDING_CANCEL_SENT:['PENDING_RECONCILING', 'PENDING_UNCERTAIN'],
  PENDING_RECONCILING:['PENDING_CANCEL_CONFIRMED', 'PENDING_FILLED_DURING_CANCEL', 'PENDING_UNCERTAIN'],
  PENDING_CANCEL_CONFIRMED:['CLOSE_INTENT_CREATED', 'COMPLETED'],
  PENDING_FILLED_DURING_CANCEL:['MANUAL_REVIEW'],
  PENDING_UNCERTAIN:['PENDING_RECONCILING', 'MANUAL_REVIEW'],
  CLOSE_INTENT_CREATED:['CLOSE_SENT', 'FAILED'],
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
  if (taskType === 'pending_cancel') return hasPending && !hasPosition
  if (taskType === 'position_exit') return hasPosition
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

function timeframeMilliseconds(timeframe) {
  const match = String(timeframe || '').toUpperCase().match(/^(M|H|D|W)(\d+)$/)
  if (!match) return null
  const unit = { M:60_000, H:3_600_000, D:86_400_000, W:604_800_000 }[match[1]]
  return unit * Number(match[2])
}

function hardInvalidation(group, context) {
  const row = lastClosedBar(context?._market, context?.as_of?.decision_timeframe)
  const close = number(row?.close)
  if (!close) return null
  for (const condition of group?.frozen_conditions || []) {
    if (condition.kind !== 'hard' || number(condition.threshold) == null) continue
    const threshold = Number(condition.threshold)
    const matched = condition.operator === 'closed_bar_lte' ? close <= threshold
      : condition.operator === 'closed_bar_gte' ? close >= threshold : false
    if (matched) return { condition, close }
  }
  return null
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
  if (row?.position_id) return true
  return Boolean(row?.pending_ticket)
    && String(row?.effective_pending_state || '').toLowerCase() === 'pending'
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
      AND (outcomes.position_id IS NOT NULL OR (
        outcomes.pending_ticket IS NOT NULL AND outcomes.position_id IS NULL
        AND COALESCE(deliveries.pending_state, origin_signals.pending_state) = 'pending'
      ))
    ORDER BY theses.created_at DESC, outcomes.id DESC`, params)
  const groups = new Map()
  for (const row of rows) {
    if (!isActivePositionManagementOutcome(row)) continue
    if (strategyVersion && Number(row.strategy_version) !== Number(strategyVersion)) continue
    if (!groups.has(row.management_group_id)) groups.set(row.management_group_id, { ...publicGroup(row), targets:[] })
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

export function validatePositionManagementResponse(value, context, validateMarketPlan) {
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

  for (const item of Array.isArray(value.pending_evaluations) ? value.pending_evaluations : []) {
    try {
      const group = pendingById.get(String(item?.management_group_id || ''))
      if (!group || seenPending.has(group.management_group_id)) throw new Error('pending_management_group_invalid')
      const action = String(item.action || '').toLowerCase()
      if (!['keep', 'cancel'].includes(action)) throw new Error('pending_action_invalid')
      const reason = text(item.reason, 1000)
      if (!reason) throw new Error('pending_reason_required')
      const evidenceRefs = validateEvidenceRefs(item.evidence_refs, group.allowed_evidence_refs)
      seenPending.add(group.management_group_id)
      pendingEvaluations.push({ management_group_id:group.management_group_id, action, reason, evidence_refs:evidenceRefs })
    } catch (error) { errors.push({ section:'pending', group_id:item?.management_group_id || null, code:error.message }) }
  }

  for (const item of Array.isArray(value.position_evaluations) ? value.position_evaluations : []) {
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
  if (taskType === 'pending_cancel') return action === 'cancel' ? 'AI 提出取消策略挂单，等待证据与执行条件复核' : '策略挂单继续保留'
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

export async function persistPositionManagementEvaluations({ signalId, context, management } = {}) {
  if (!signalId || !context?._targets || !management) return []
  const candidates = [
    ...(management.pending_evaluations || []).filter(item => item.action === 'cancel').map(item => ({ ...item, taskType:'pending_cancel' })),
    ...(management.position_evaluations || []).filter(item => item.action === 'exit').map(item => ({ ...item, taskType:'position_exit' })),
  ]
  const existingPositionGroups = new Set(candidates.filter(item => item.taskType === 'position_exit')
    .map(item => item.management_group_id))
  for (const group of context.position_groups || []) {
    const hard = hardInvalidation(group, context)
    if (!hard || existingPositionGroups.has(group.management_group_id)) continue
    candidates.push({
      taskType:'position_exit', management_group_id:group.management_group_id,
      thesis_id:group.thesis_id, action:'exit', matched_condition_id:hard.condition.condition_id,
      reversal_candidate:false, server_derived:true,
      reason:`已收盘 K 线价格 ${hard.close} 命中冻结硬失效条件，服务端生成平仓候选`,
      evidence_refs:[`bar:${context.as_of.decision_timeframe}:${context.as_of.closed_bar_time_utc_ms}`,
        `condition:${hard.condition.condition_id}`],
    })
  }
  const allTargets = candidates.flatMap(item => (context._targets.get(item.management_group_id) || [])
    .filter(target => targetMatchesPositionManagementTask(target, item.taskType)))
  const modes = await resolveModes(allTargets)
  const created = []
  for (const evaluation of candidates) {
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
      const group = (context.position_groups || []).find(item => item.management_group_id === evaluation.management_group_id)
        || (context.pending_groups || []).find(item => item.management_group_id === evaluation.management_group_id)
      const matchedCondition = (group?.frozen_conditions || [])
        .find(condition => condition.condition_id === evaluation.matched_condition_id)
      const currentHardInvalidation = hardInvalidation(group, context)
      let evidenceValidation = { status:'candidate', source:'model', reason:'awaiting_evidence_confirmation' }
      if (matchedCondition?.kind === 'hard'
        && currentHardInvalidation?.condition?.condition_id === matchedCondition.condition_id) {
        evidenceValidation = { status:'confirmed', source:'server_hard_condition',
          condition_id:matchedCondition.condition_id, closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms }
      } else if (evaluation.taskType === 'pending_cancel') {
        const previous = await queryOne(`SELECT closed_bar_time_utc_ms, model_evaluation_json
          FROM ai_position_management_tasks
          WHERE user_id = ? AND outcome_id = ? AND management_group_id = ?
            AND task_type = 'pending_cancel' AND candidate_action = 'cancel'
            AND closed_bar_time_utc_ms < ?
          ORDER BY closed_bar_time_utc_ms DESC, id DESC LIMIT 1`, [
          target.user_id, target.outcome_id, target.management_group_id, context.as_of.closed_bar_time_utc_ms,
        ])
        const previousEvaluation = json(previous?.model_evaluation_json, {})
        const interval = timeframeMilliseconds(context.as_of.decision_timeframe)
        const previousTime = number(previous?.closed_bar_time_utc_ms)
        const consecutive = previousTime && interval
          ? Number(context.as_of.closed_bar_time_utc_ms) - previousTime <= interval * 1.5 : Boolean(previousTime)
        if (consecutive && previousEvaluation.action === 'cancel') {
          evidenceValidation = { status:'confirmed', source:'two_closed_bar_pending_confirmations',
            previous_closed_bar_time_utc_ms:previousTime,
            closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms }
        } else {
          evidenceValidation = { status:'candidate', source:'pending_cancel_first_confirmation',
            closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms }
        }
      } else if (evaluation.taskType === 'position_exit' && matchedCondition?.kind === 'soft') {
        const previous = await queryOne(`SELECT closed_bar_time_utc_ms, model_evaluation_json
          FROM ai_position_management_tasks
          WHERE user_id = ? AND outcome_id = ? AND management_group_id = ?
            AND candidate_action = 'exit' AND closed_bar_time_utc_ms < ?
          ORDER BY closed_bar_time_utc_ms DESC, id DESC LIMIT 1`, [
          target.user_id, target.outcome_id, target.management_group_id, context.as_of.closed_bar_time_utc_ms,
        ])
        const previousEvaluation = json(previous?.model_evaluation_json, {})
        const interval = timeframeMilliseconds(context.as_of.decision_timeframe)
        const previousTime = number(previous?.closed_bar_time_utc_ms)
        const consecutive = previousTime && interval
          ? Number(context.as_of.closed_bar_time_utc_ms) - previousTime <= interval * 1.5 : Boolean(previousTime)
        if (consecutive && previousEvaluation.matched_condition_id === matchedCondition.condition_id) {
          evidenceValidation = { status:'confirmed', source:'two_closed_bar_model_confirmations',
            condition_id:matchedCondition.condition_id, previous_closed_bar_time_utc_ms:previousTime,
            closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms }
        } else {
          evidenceValidation = { status:'candidate', source:'soft_condition_first_confirmation',
            condition_id:matchedCondition.condition_id, closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms }
        }
      }
      const now = beijingNow()
      const result = await queryRun(`INSERT IGNORE INTO ai_position_management_tasks
        (task_key, task_type, execution_mode, user_id, trading_account_id, ownership_history_id,
         broker_server_key, login_account, bridge_generation, original_symbol, standard_symbol,
         strategy_id, strategy_version, management_group_id, thesis_id, origin_signal_id,
         decision_signal_id, outcome_id, decision_timeframe, closed_bar_time_utc_ms,
         market_snapshot_hash, candidate_action, reversal_candidate, model_evaluation_json,
         evidence_validation_json, status, state_version, candidate_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'CANDIDATE', 1, DATE_ADD(NOW(), INTERVAL 1 DAY), ?, ?)`, [
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
        VALUES (?, NULL, 'CANDIDATE', 'candidate_created', ?, ?, 'model', ?)`, [
        taskId, taskSummary(evaluation.action, evaluation.taskType), JSON.stringify({ mode, evaluation }), now,
      ])
      let taskStatus = 'CANDIDATE'
      let stateVersion = 1
      if (evidenceValidation.status === 'confirmed') {
        await queryRun(`UPDATE ai_position_management_tasks
          SET status = 'EVIDENCE_CONFIRMED', state_version = 2, updated_at = ?
          WHERE id = ? AND status = 'CANDIDATE' AND state_version = 1`, [now, taskId])
        await queryRun(`INSERT INTO ai_position_management_events
          (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
          VALUES (?, 'CANDIDATE', 'EVIDENCE_CONFIRMED', 'evidence_confirmed',
            '冻结失效条件已由服务端证据确认', ?, 'system', ?)`, [taskId, JSON.stringify(evidenceValidation), now])
        taskStatus = 'EVIDENCE_CONFIRMED'
        stateVersion = 2
      }
      const task = { id:taskId, user_id:Number(target.user_id), status:taskStatus, state_version:stateVersion, execution_mode:mode,
        task_type:evaluation.taskType, management_group_id:target.management_group_id,
        thesis_id:target.thesis_id, candidate_action:evaluation.action, updated_at:now }
      created.push(task)
      broadcastPositionManagementTask(task, 'candidate_created')
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
    if (!canTransitionPositionManagement(task.status, toStatus)) throw new Error('position_management_transition_invalid')
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
  await queryRun(`INSERT INTO ai_position_management_commands
    (task_id, command_sequence, operation_id, command_type, expected_state_json, request_json,
     send_status, reconciliation_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'prepared', 'pending', ?, ?)
    ON DUPLICATE KEY UPDATE operation_id = operation_id`, [
    taskId, sequence, operationId, commandType, JSON.stringify(expectedState || {}), JSON.stringify(request || {}), now, now,
  ])
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
  const rows = await queryAll(`SELECT tasks.*, users.nickname AS user_nickname, users.email AS user_email
    FROM ai_position_management_tasks tasks LEFT JOIN users ON users.id = tasks.user_id
    ${clause} ORDER BY tasks.id DESC LIMIT ? OFFSET ?`, [...params, safeSize, (normalizedPage - 1) * safeSize])
  return { tasks:rows, pagination:{ page:normalizedPage, page_size:safeSize, total, pages } }
}

export async function getPositionManagementTask(taskId, { userId = null, admin = false } = {}) {
  const task = await queryOne(`SELECT * FROM ai_position_management_tasks WHERE id = ?${admin ? '' : ' AND user_id = ?'}`,
    admin ? [taskId] : [taskId, userId])
  if (!task) return null
  const [events, commands] = await Promise.all([
    queryAll('SELECT * FROM ai_position_management_events WHERE task_id = ? ORDER BY id', [taskId]),
    queryAll('SELECT * FROM ai_position_management_commands WHERE task_id = ? ORDER BY command_sequence, id', [taskId]),
  ])
  return { task, events, commands }
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
