import crypto from 'node:crypto'
import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'
import { broadcastAdminEvent, getBridgeGeneration, sendToBrowsers } from '../../bridge-ws.js'
import { stripBrokerSuffix, timeframeIntervalMs } from './utils.js'

export const POSITION_MANAGEMENT_CONTRACT_VERSION = 'position-management-v1.7'
export const POSITION_MANAGEMENT_MODES = ['display', 'auto_exit', 'auto_reverse']
export const POSITION_MANAGEMENT_MAX_GROUPS = 20
export const POSITION_MANAGEMENT_MAX_CONTEXT_CHARS = 32_000
export const AUTO_EXIT_CONFIRMATIONS_REQUIRED = 2
const POSITION_MANAGEMENT_ROTATION_BATCH_MAX_SECTIONS = Math.floor(POSITION_MANAGEMENT_MAX_GROUPS / 2)
const POSITION_MANAGEMENT_ROTATION_SAFETY_MARGIN_CHARS = 1024

const MARKET_ALIGNMENT_VALUES = new Set(['aligned', 'misaligned', 'uncertain'])
const MANAGEMENT_REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/

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
const positiveNumber = value => { const parsed = number(value); return parsed && parsed > 0 ? parsed : null }
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

function terminalBarTimeMs(value) {
  const direct = number(value?.time_utc_msc ?? value?.utc_time_msc ?? value?.time_msc)
  if (direct && direct > 0) return Math.trunc(direct)
  const seconds = number(value?.time_utc ?? value?.time)
  if (seconds && seconds > 0) return Math.trunc(seconds > 10_000_000_000 ? seconds : seconds * 1000)
  const parsed = Date.parse(String(value?.time_utc ?? value?.time ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

function closedBarWindow(market, timeframe) {
  const currentTime = lastClosedBarTime(market, timeframe)
  const frame = market?.strategy_context?.timeframes?.[timeframe]
  const rows = Array.isArray(frame?.klines) ? frame.klines : []
  const previousTimes = [...new Set(rows.map(terminalBarTimeMs)
    .filter(value => Number.isFinite(value) && value > 0 && (!currentTime || value < currentTime)))]
    .sort((left, right) => left - right)
  return {
    current_closed_bar_time_utc_ms:currentTime,
    previous_closed_bar_time_utc_ms:previousTimes.at(-1) || null,
  }
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
  const originalTakeProfits = json(row.original_take_profits_json, [])
  return {
    management_group_id:row.management_group_id,
    thesis_id:row.thesis_id,
    strategy_id:Number(row.strategy_id),
    strategy_version:Number(row.strategy_version || 1),
    strategy_scope:text(row.strategy_scope, 32).toLowerCase() === 'private' ? 'private' : 'platform',
    standard_symbol:row.standard_symbol,
    direction:row.direction,
    original_signal_id:Number(row.origin_signal_id || row.signal_id),
    core_entry_reason:text(row.core_entry_reason, 1000),
    entry_method:text(row.entry_method, 64).toLowerCase() || null,
    decision_timeframe:row.decision_timeframe,
    original_stop_loss:positiveNumber(row.original_stop_loss),
    original_take_profits:Array.isArray(originalTakeProfits) ? originalTakeProfits : [],
    // Frozen thesis details are supplied as context only.  They describe the
    // original entry logic; the model must compare that logic with current
    // market facts and may not treat protective prices as exit gates.
    allowed_evidence_refs:[],
  }
}

function terminalDirection(value, fallback = null) {
  return normalizeDirection(value?.direction || value?.side || value?.type
    || value?.pending_type || fallback)
}

function terminalTime(value, ...keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (candidate != null && String(candidate).trim() !== '') return candidate
  }
  return null
}

function terminalFact(value, row, kind, source) {
  const pending = kind === 'pending'
  const direction = terminalDirection(value, row?.direction)
  const orderType = text(value?.order_type || value?.pending_type || value?.type
    || (pending ? row?.entry_method : 'position'), 64).toLowerCase() || null
  const entryPrice = number(value?.entry_price ?? value?.open_price ?? value?.price_open)
  const triggerPrice = number(value?.trigger_price ?? value?.price)
  const currentPrice = number(value?.current_price ?? value?.price_current)
  const originalTakeProfits = json(row?.original_take_profits_json, [])
  const result = {
    source,
    kind,
    direction,
    order_type:orderType,
    entry_price:pending ? null : (entryPrice && entryPrice > 0 ? entryPrice : null),
    trigger_price:pending ? (triggerPrice && triggerPrice > 0 ? triggerPrice : null) : null,
    current_price:pending ? null : (currentPrice && currentPrice > 0 ? currentPrice : null),
    actual_stop_loss:positiveNumber(value?.actual_stop_loss ?? value?.sl),
    actual_take_profit:positiveNumber(value?.actual_take_profit ?? value?.tp),
    original_stop_loss:positiveNumber(value?.original_stop_loss ?? row?.original_stop_loss),
    original_take_profits:Array.isArray(value?.original_take_profits)
      ? value.original_take_profits : (Array.isArray(originalTakeProfits) ? originalTakeProfits : []),
    opened_at:pending ? null : terminalTime(value, 'opened_at', 'open_time', 'time_open', 'time'),
    created_at:terminalTime(value, 'created_at', 'created_at_utc', 'time_setup', 'time_create', 'time')
      || row?.created_at || null,
  }
  return result
}

function terminalFactComplete(fact, kind) {
  if (!fact || fact.kind !== kind || !fact.direction || !fact.order_type) return false
  if (kind === 'position') return Number(fact.entry_price) > 0 && Number(fact.current_price) > 0
  return Number(fact.trigger_price) > 0
}

function lookupKeys(value, keys) {
  return keys.map(key => value?.[key]).map(value => value == null ? '' : String(value).trim())
    .filter(Boolean)
}

function mapTerminalRows(rows, keys) {
  const map = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const key of lookupKeys(row, keys)) if (!map.has(key)) map.set(key, row)
  }
  return map
}

export function isActivePositionManagementOutcome(row) {
  if (row?.pending_ticket
    && String(row?.effective_pending_state || '').toLowerCase() === 'pending') return true
  if (row?.position_id) return true
  return false
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
      outcomes.actual_stop_loss, outcomes.actual_take_profit,
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
  const isPlatformStrategy = strategyScope === 'platform'
  const hasReferencePortfolio = referencePortfolio?.role === 'platform_strategy_reference_portfolio'
  const referencePortfolioIdentityValid = !isPlatformStrategy || (
    (referencePortfolio?.strategy_id == null || Number(referencePortfolio.strategy_id) === Number(strategyId))
    && (referencePortfolio?.symbol == null
      || stripBrokerSuffix(String(referencePortfolio.symbol)).toUpperCase() === standardSymbol)
  )
  const referencePortfolioAvailable = hasReferencePortfolio && referencePortfolioIdentityValid
    && referencePortfolio?.status !== 'unavailable'
    && Array.isArray(referencePortfolio?.positions)
    && Array.isArray(referencePortfolio?.pending_orders)
  const referenceFactsByOutcome = new Map()
  const referenceOutcomeIds = new Set()
  if (referencePortfolioAvailable) {
    for (const item of referencePortfolio.positions) {
      const outcomeId = Number(/^outcome:(\d+)$/.exec(String(item?.reference_id || ''))?.[1] || 0)
      if (outcomeId > 0) {
        referenceOutcomeIds.add(outcomeId)
        referenceFactsByOutcome.set(outcomeId,
          { ...(referenceFactsByOutcome.get(outcomeId) || {}), position:item })
      }
    }
    for (const item of referencePortfolio.pending_orders) {
      const outcomeId = Number(/^outcome:(\d+)$/.exec(String(item?.reference_id || ''))?.[1] || 0)
      if (outcomeId > 0) {
        referenceOutcomeIds.add(outcomeId)
        referenceFactsByOutcome.set(outcomeId,
          { ...(referenceFactsByOutcome.get(outcomeId) || {}), pending:item })
      }
    }
  }
  const privatePortfolioAvailable = Array.isArray(market?.positions)
    && Array.isArray(market?.pending_orders)
  const privatePositionRows = mapTerminalRows(market?.positions,
    ['position_id', 'identifier', 'ticket', 'position_ticket'])
  const privatePendingRows = mapTerminalRows(market?.pending_orders,
    ['ticket', 'mt5_ticket', 'order_id', 'pending_ticket'])

  const asOf = buildPositionManagementAsOf(market, decisionTimeframe)
  const initialReferenceFactsStatus = isPlatformStrategy
    ? (referencePortfolioAvailable ? 'missing' : 'unavailable')
    : (privatePortfolioAvailable ? 'missing' : 'unavailable')
  const executionTargetsSeen = new Set()

  // A platform model is authoritative only for the live observer portfolio.
  // Subscriber outcomes are deliberately loaded only as a later execution
  // lineage lookup after a valid cancel/exit decision.  Keeping this identity
  // non-enumerable preserves the anonymous model contract while allowing that
  // lookup to bind to the exact frozen source signal.
  const platformReferenceRows = isPlatformStrategy
    ? rows.filter(row => referenceOutcomeIds.has(Number(row?.outcome_id)))
    : rows

  const resolveTerminalFact = (row, kind) => {
    if (isPlatformStrategy) {
      if (!referencePortfolioAvailable) return null
      const facts = referenceFactsByOutcome.get(Number(row?.outcome_id))
      const source = facts?.[kind]
      return source ? terminalFact(source, row, kind, 'platform_reference_portfolio') : null
    }
    if (!privatePortfolioAvailable) return null
    const keys = kind === 'position'
      ? lookupKeys(row, ['position_id', 'pending_ticket'])
      : lookupKeys(row, ['pending_ticket', 'position_id'])
    const source = (kind === 'position' ? privatePositionRows : privatePendingRows)
      && keys.map(key => (kind === 'position' ? privatePositionRows : privatePendingRows).get(key)).find(Boolean)
    return source ? terminalFact(source, row, kind, 'private_market') : null
  }
  const groups = new Map()
  for (const rawRow of platformReferenceRows) {
    const row = normalizePositionManagementOutcome(rawRow)
    if (!isActivePositionManagementOutcome(row)) continue
    if (!row.management_group_id) continue
    if (isPlatformStrategy) {
      const referenceFacts = referenceFactsByOutcome.get(Number(row.outcome_id)) || {}
      const reference = referenceFacts.position || referenceFacts.pending
      if (!reference) continue
      if (reference.origin_signal_id != null
        && Number(reference.origin_signal_id) !== Number(row.origin_signal_id)) continue
      if (reference.thesis_id != null
        && String(reference.thesis_id || '') !== String(row.thesis_id || '')) continue
      if (reference.management_group_id != null
        && String(reference.management_group_id || '') !== String(row.management_group_id || '')) continue
    }
    const targetKey = `${String(row.management_group_id)}:${Number(row.outcome_id)}`
    if (executionTargetsSeen.has(targetKey)) continue
    executionTargetsSeen.add(targetKey)
    // Active system positions/pending orders remain in the current-state
    // review after a strategy version changes.  Keep the thesis version on
    // the target for audit, but do not drop a live outcome from management.
    if (!groups.has(row.management_group_id)) {
      const group = { ...publicGroup(row), targets:[] }
      group.pending_order_facts = []
      group.position_facts = []
      group.allowed_evidence_refs_by_kind = { pending:[], position:[] }
      group.decision_context_status = group.core_entry_reason && group.entry_method
        && group.decision_timeframe && group.direction && asOf.closed_bar_time_utc_ms
        && asOf.market_snapshot_hash ? 'available' : 'unavailable'
      group.reference_facts_status_by_kind = { pending:initialReferenceFactsStatus, position:initialReferenceFactsStatus }
      groups.set(row.management_group_id, group)
    }
    const group = groups.get(row.management_group_id)
    const kind = row.position_id ? 'position' : 'pending'
    const fact = resolveTerminalFact(row, kind)
    if (fact) {
      if (kind === 'position') group.position_facts.push(fact)
      else group.pending_order_facts.push(fact)
    }
    if (fact && terminalFactComplete(fact, kind)) {
      group.allowed_evidence_refs_by_kind[kind].push(`terminal:${row.outcome_id}:${kind}`)
      group.reference_facts_status_by_kind[kind] = 'available'
    } else if (fact && group.reference_facts_status_by_kind[kind] !== 'available') {
      group.reference_facts_status_by_kind[kind] = 'unavailable'
    }
    group.targets.push(row)
  }
  const currentBarRef = asOf.closed_bar_time_utc_ms
    ? `bar:${asOf.decision_timeframe}:${asOf.closed_bar_time_utc_ms}` : null
  const currentSnapshotRef = asOf.market_snapshot_hash
    ? `snapshot:${String(asOf.market_snapshot_hash).replace(/^sha256:/, '')}` : null
  const descriptors = []
  for (const group of groups.values()) {
    const hasPosition = group.targets.some(row => row.position_id)
    const hasPending = group.targets.some(row => row.pending_ticket && !row.position_id)
    // Build independent model sections.  A management group can contain a
    // filled subscriber position and another subscriber's pending order at
    // the same time; facts and terminal evidence must never cross sections.
    const buildModelGroup = kind => {
      const safe = { ...group,
        position_facts:kind === 'position' ? [...group.position_facts] : [],
        pending_order_facts:kind === 'pending' ? [...group.pending_order_facts] : [],
      }
      delete safe.targets
      delete safe.reference_facts_status_by_kind
      delete safe.allowed_evidence_refs_by_kind
      // Missing reference facts are represented by reference_facts_status. Do
      // not add null terminal facts: the model must not infer a broker state
      // from an absent observer snapshot.
      const kindEvidenceRefs = group.allowed_evidence_refs_by_kind[kind]
      safe.allowed_evidence_refs = [...new Set([
        ...(kindEvidenceRefs || []),
        ...(currentBarRef ? [currentBarRef] : []),
        ...(currentSnapshotRef ? [currentSnapshotRef] : []),
      ])]
      safe.reference_facts_status = group.reference_facts_status_by_kind[kind]
      return safe
    }
    const sections = {
      position:hasPosition ? buildModelGroup('position') : null,
      pending:hasPending ? buildModelGroup('pending') : null,
    }
    descriptors.push({
      management_group_id:group.management_group_id,
      stable_key:String(group.management_group_id),
      section_weight:Number(Boolean(sections.position)) + Number(Boolean(sections.pending)),
      sections,
      targets:group.targets,
    })
  }

  const buildContext = selected => {
    const pending = selected.map(item => item.sections.pending).filter(Boolean)
    const positions = selected.map(item => item.sections.position).filter(Boolean)
    const context = {
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
      as_of:asOf,
      pending_groups:pending,
      position_groups:positions,
    }
    return { context, pending, positions, chars:JSON.stringify(context).length }
  }

  const allBuild = buildContext(descriptors)
  const totalGroupCount = descriptors.length
  const totalSectionCount = descriptors.reduce((sum, item) => sum + item.section_weight, 0)
  const allFits = totalSectionCount <= POSITION_MANAGEMENT_MAX_GROUPS
    && allBuild.chars <= POSITION_MANAGEMENT_MAX_CONTEXT_CHARS
  let selectedDescriptors = descriptors
  let selectionMode = 'all'
  let rotationSlot = null
  let batchCount = allFits ? 1 : 0
  let oversizedGroupCount = 0
  let deferredGroupCount = 0

  if (!allFits) {
    selectionMode = 'rotating'
    const emptyContextChars = buildContext([]).chars
    const batchCharBudget = Math.floor((POSITION_MANAGEMENT_MAX_CONTEXT_CHARS
      - emptyContextChars - POSITION_MANAGEMENT_ROTATION_SAFETY_MARGIN_CHARS) / 2)
    const batches = []
    const oversized = []
    let currentBatch = []
    const sortedDescriptors = [...descriptors].sort((left, right) => left.stable_key < right.stable_key ? -1 : 1)
    const pushCurrentBatch = () => {
      if (currentBatch.length) batches.push(currentBatch)
      currentBatch = []
    }
    for (const descriptor of sortedDescriptors) {
      if (descriptor.section_weight > POSITION_MANAGEMENT_ROTATION_BATCH_MAX_SECTIONS) {
        oversized.push(descriptor)
        continue
      }
      const alone = buildContext([descriptor]).chars
      if (alone > batchCharBudget) {
        oversized.push(descriptor)
        continue
      }
      const candidate = [...currentBatch, descriptor]
      const candidateBuild = buildContext(candidate)
      if (candidate.reduce((sum, item) => sum + item.section_weight, 0)
        <= POSITION_MANAGEMENT_ROTATION_BATCH_MAX_SECTIONS
        && candidateBuild.chars <= batchCharBudget) {
        currentBatch = candidate
      } else {
        pushCurrentBatch()
        currentBatch = [descriptor]
      }
    }
    pushCurrentBatch()
    batchCount = batches.length
    oversizedGroupCount = oversized.length
    if (batchCount > 1) {
      const interval = timeframeIntervalMs(asOf.decision_timeframe)
      const closedBarTime = Number(asOf.closed_bar_time_utc_ms)
      if (!Number.isFinite(closedBarTime) || closedBarTime <= 0 || !interval) {
        throw new Error('position_management_rotation_bar_unavailable')
      }
      rotationSlot = ((Math.floor(closedBarTime / interval) % batchCount) + batchCount) % batchCount
      const previousSlot = (rotationSlot - 1 + batchCount) % batchCount
      selectedDescriptors = [...batches[rotationSlot], ...batches[previousSlot]]
    } else if (batchCount === 1) {
      selectedDescriptors = batches[0]
      rotationSlot = 0
    } else {
      selectedDescriptors = []
    }
    const selectedKeys = new Set(selectedDescriptors.map(item => item.stable_key))
    deferredGroupCount = Math.max(0, totalGroupCount - selectedKeys.size - oversizedGroupCount)
  }
  const selectedBuild = buildContext(selectedDescriptors)
  if (selectedBuild.chars > POSITION_MANAGEMENT_MAX_CONTEXT_CHARS
    || selectedBuild.pending.length + selectedBuild.positions.length > POSITION_MANAGEMENT_MAX_GROUPS) {
    throw new Error('position_management_selected_context_over_budget')
  }
  const context = selectedBuild.context
  const pendingGroups = selectedBuild.pending
  const positionGroups = selectedBuild.positions
  const selectedKeys = new Set(selectedDescriptors.map(item => item.stable_key))
  const targets = new Map(selectedDescriptors
    .filter(item => selectedKeys.has(item.stable_key))
    .map(item => [item.management_group_id, item.targets]))
  const contextChars = selectedBuild.chars
  const groupCount = pendingGroups.length + positionGroups.length
  const previousClosedBarTime = closedBarWindow(market, decisionTimeframe).previous_closed_bar_time_utc_ms
  Object.defineProperty(context, '_targets', { value:targets, enumerable:false })
  Object.defineProperty(context, '_executionLineage', {
    value:isPlatformStrategy ? {
      strategy_scope:'platform',
      source_outcome_ids:[...referenceOutcomeIds],
      source_user_ids:[...new Set(platformReferenceRows.map(row => Number(row?.user_id)).filter(id => id > 0))],
    } : { strategy_scope:'private' },
    enumerable:false,
  })
  Object.defineProperty(context, '_market', { value:market, enumerable:false })
  Object.defineProperty(context, '_diagnostics', {
    value:{ group_count:groupCount, pending_count:pendingGroups.length,
      position_count:positionGroups.length, context_chars:contextChars,
      total_group_count:totalGroupCount, total_section_count:totalSectionCount,
      selected_group_count:selectedKeys.size, selected_section_count:groupCount,
      deferred_group_count:deferredGroupCount, oversized_group_count:oversizedGroupCount,
      selection_mode:selectionMode, rotation_slot:rotationSlot, batch_count:batchCount,
      previous_closed_bar_time_utc_ms:previousClosedBarTime },
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
      thesis_id:group.thesis_id,
      origin_signal_id:group.original_signal_id,
      action:'仅允许 keep | cancel',
      market_alignment:'仅允许 aligned | misaligned | uncertain，作为当前策略判断的描述字段，不决定 action',
      cancel_reason_code:'action=cancel 时填写当前策略定义的 lowercase_snake_case 原因码；keep 时为 null',
      reason:'简体中文说明当前策略为何保留或取消该挂单',
      evidence_refs:`只能引用：${(group.allowed_evidence_refs || []).join('、') || '空集合'}`,
    })),
    position_evaluations:(context.position_groups || []).map(group => ({
      management_group_id:group.management_group_id,
      thesis_id:group.thesis_id,
      origin_signal_id:group.original_signal_id,
      action:'仅允许 hold | exit',
      market_alignment:'仅允许 aligned | misaligned | uncertain，作为当前策略判断的描述字段，不决定 action',
      exit_reason_code:'action=exit 时填写当前策略定义的 lowercase_snake_case 原因码；hold 时为 null',
      reversal_candidate:'布尔值，仅为解释性判断，不是执行命令',
      reason:'简体中文说明当前策略为何继续持有或退出该持仓',
      evidence_refs:`只能引用：${(group.allowed_evidence_refs || []).join('、') || '空集合'}`,
    })),
    analysis:'简体中文行情分析',
    reasoning:'简体中文说明新信号、挂单和持仓三个部分的独立依据',
  }, null, 2)
}

function validateAsOf(value, context) {
  // A response and its server context must be from the same contract
  // generation.  In particular, do not allow a rolling deployment to combine
  // a prior-contract thesis/context with the current-state response.
  if (String(context?.contract_version || '') !== POSITION_MANAGEMENT_CONTRACT_VERSION
    || String(value?.contract_version || '') !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
    throw new Error('position_management_contract_version_mismatch')
  }
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
  const exitReasonCode = item?.exit_reason_code
  const normalizedExitReasonCode = String(exitReasonCode ?? '').trim().toLowerCase()
  if (normalizedExitReasonCode && !['null', 'none'].includes(normalizedExitReasonCode)) return true
  if (action === 'exit' || (action && action !== 'hold')) return true
  return false
}

function normalizeMarketAlignment(value) {
  const alignment = String(value ?? '').trim().toLowerCase()
  return MARKET_ALIGNMENT_VALUES.has(alignment) ? alignment : null
}

function groupDecisionContextAvailable(group) {
  return String(group?.decision_context_status || '').toLowerCase() === 'available'
}

function groupReferenceFactsAvailableForEvaluation(group) {
  const status = String(group?.reference_facts_status || '').toLowerCase()
  const scope = String(group?.strategy_scope || 'platform').toLowerCase()
  // Platform groups are created only from the observer's current reference
  // portfolio.  Missing or unavailable facts therefore cannot resurrect a
  // stale thesis, nor authorize cancel/exit from historical subscriber state.
  // Private strategies retain their own terminal-inventory fail-closed rule.
  if (scope === 'private') return status === 'available'
  return status === 'available'
}

function groupManagementFactsAvailable(group) {
  return groupDecisionContextAvailable(group) && groupReferenceFactsAvailableForEvaluation(group)
}

function safePendingEvaluation(groupId, thesisId = null,
  reason = '该管理组未通过模型输出校验，服务端按安全默认继续保留挂单') {
  return {
    management_group_id:groupId, thesis_id:thesisId, action:'keep', market_alignment:'uncertain',
    cancel_reason_code:null, reason, evidence_refs:[], validation_source:'server_fail_closed',
  }
}

function safePositionEvaluation(groupId, thesisId, reason = '该管理组未通过模型输出校验，服务端按安全默认继续持有') {
  return {
    management_group_id:groupId, thesis_id:thesisId, action:'hold', market_alignment:'uncertain',
    exit_reason_code:null, reversal_candidate:false, reason, evidence_refs:[],
    validation_source:'server_fail_closed',
  }
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
      if (item?.thesis_id != null && String(item.thesis_id || '') !== String(group.thesis_id || '')) {
        throw new Error('pending_thesis_invalid')
      }
      if (item?.origin_signal_id != null
        && Number(item.origin_signal_id) !== Number(group.original_signal_id)) {
        throw new Error('pending_origin_signal_invalid')
      }
      const action = String(item.action || '').toLowerCase()
      if (!['keep', 'cancel'].includes(action)) throw new Error('pending_action_invalid')
      const marketAlignment = normalizeMarketAlignment(item?.market_alignment)
      if (!marketAlignment) throw new Error('pending_market_alignment_required')
      if (!groupDecisionContextAvailable(group)) throw new Error('pending_decision_context_unavailable')
      if (!groupReferenceFactsAvailableForEvaluation(group)) throw new Error('pending_reference_facts_unavailable')
      const rawCancelReasonCode = item?.cancel_reason_code
      const hasCancelReasonCode = rawCancelReasonCode !== undefined && rawCancelReasonCode !== null
        && String(rawCancelReasonCode).trim() !== ''
      if (action === 'cancel' && (!hasCancelReasonCode
        || !MANAGEMENT_REASON_CODE.test(String(rawCancelReasonCode).trim().toLowerCase()))) {
        throw new Error('pending_cancel_reason_code_required')
      }
      if (action !== 'cancel' && hasCancelReasonCode
        && String(rawCancelReasonCode).trim().toLowerCase() !== 'none') {
        throw new Error('pending_keep_cancel_reason_code_invalid')
      }
      const cancelReasonCode = action === 'cancel'
        ? String(rawCancelReasonCode).trim().toLowerCase() : null
      const reason = text(item.reason, 1000)
      if (!reason) throw new Error('pending_reason_required')
      const evidenceRefs = validateEvidenceRefs(item.evidence_refs, group.allowed_evidence_refs)
      seenPending.add(group.management_group_id)
      pendingEvaluations.push({ management_group_id:group.management_group_id,
        thesis_id:group.thesis_id, origin_signal_id:Number(group.original_signal_id) || null, action,
        market_alignment:marketAlignment,
        cancel_reason_code:cancelReasonCode, reason, evidence_refs:evidenceRefs })
    } catch (error) { errors.push({ section:'pending', group_id:item?.management_group_id || null, code:error.message }) }
  }

  for (const item of positionItems) {
    try {
      const group = positionById.get(String(item?.management_group_id || ''))
      if (!group || seenPosition.has(group.management_group_id)) throw new Error('position_management_group_invalid')
      if (String(item.thesis_id || '') !== String(group.thesis_id)) throw new Error('position_thesis_invalid')
      if (item?.origin_signal_id != null
        && Number(item.origin_signal_id) !== Number(group.original_signal_id)) {
        throw new Error('position_origin_signal_invalid')
      }
      const action = String(item.action || '').toLowerCase()
      if (!['hold', 'exit'].includes(action)) throw new Error('position_action_invalid')
      const marketAlignment = normalizeMarketAlignment(item?.market_alignment)
      if (!marketAlignment) throw new Error('position_market_alignment_required')
      if (!groupDecisionContextAvailable(group)) throw new Error('position_decision_context_unavailable')
      if (!groupReferenceFactsAvailableForEvaluation(group)) throw new Error('position_reference_facts_unavailable')
      const rawExitReasonCode = item?.exit_reason_code
      const hasExitReasonCode = rawExitReasonCode !== undefined && rawExitReasonCode !== null
        && String(rawExitReasonCode).trim() !== ''
      const exitReasonCode = hasExitReasonCode ? String(rawExitReasonCode).trim().toLowerCase() : null
      if (action === 'exit' && (!exitReasonCode || !MANAGEMENT_REASON_CODE.test(exitReasonCode))) {
        throw new Error('position_exit_reason_code_required')
      }
      if (action === 'hold' && hasExitReasonCode && exitReasonCode !== 'null') {
        throw new Error('position_hold_exit_reason_code_invalid')
      }
      const reason = text(item.reason, 1000)
      if (!reason) throw new Error('position_reason_required')
      const evidenceRefs = validateEvidenceRefs(item.evidence_refs, group.allowed_evidence_refs)
      seenPosition.add(group.management_group_id)
      positionEvaluations.push({
        management_group_id:group.management_group_id, thesis_id:group.thesis_id,
        origin_signal_id:Number(group.original_signal_id) || null, action,
        market_alignment:marketAlignment,
        exit_reason_code:exitReasonCode === 'null' ? null : exitReasonCode,
        reversal_candidate:Boolean(item.reversal_candidate),
        reason, evidence_refs:evidenceRefs,
      })
    } catch (error) { errors.push({ section:'position', group_id:item?.management_group_id || null, code:error.message }) }
  }

  for (const [groupId, group] of pendingById) if (!seenPending.has(groupId)) {
    errors.push({ section:'pending', group_id:groupId, code:'evaluation_missing' })
    pendingEvaluations.push({
      ...safePendingEvaluation(groupId, group.thesis_id),
    })
  }
  for (const [groupId, group] of positionById) if (!seenPosition.has(groupId)) {
    errors.push({ section:'position', group_id:groupId, code:'evaluation_missing' })
    positionEvaluations.push({
      ...safePositionEvaluation(groupId, group.thesis_id),
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
  return action === 'exit' ? 'AI 提出平掉策略持仓，当前仅记录并复核' : '当前行情仍支持继续持有'
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

function executionGroup(context, groupId, section) {
  const groups = section === 'position' ? context?.position_groups : context?.pending_groups
  return (groups || []).find(group => String(group?.management_group_id || '') === String(groupId || '')) || null
}

function lineageTargetFromRow(row) {
  return {
    outcome_id:Number(row.outcome_id), delivery_id:Number(row.delivery_id), order_intent_id:Number(row.order_intent_id),
    user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id), ownership_history_id:row.ownership_history_id,
    broker_server_key:row.broker_server_key, login_account:row.login_account,
    original_symbol:row.original_symbol || row.symbol, symbol:row.symbol,
    standard_symbol:stripBrokerSuffix(String(row.original_symbol || row.symbol || '')).toUpperCase(),
    pending_ticket:row.pending_ticket, position_id:row.position_id,
    entry_direction:row.entry_direction, system_magic:row.system_magic,
    attribution_status:row.attribution_status, actual_stop_loss:row.actual_stop_loss,
    actual_take_profit:row.actual_take_profit, effective_pending_state:row.effective_pending_state,
    strategy_id:Number(row.strategy_id), strategy_version:Number(row.strategy_version || 1),
    strategy_scope:row.strategy_scope, management_group_id:row.management_group_id,
    thesis_id:row.thesis_id, origin_signal_id:Number(row.origin_signal_id),
  }
}

/**
 * Resolve subscriber execution targets only after a validated cancel/exit.
 * The observer outcome is a model fact, not an execution target.  Every
 * returned row must have one delivery, its frozen origin signal, one order
 * intent and one matching outcome; ambiguous or incomplete lineage is
 * dropped rather than guessed.
 */
export async function resolvePositionManagementExecutionTargets({ context, groupId, section, action } = {}) {
  const group = executionGroup(context, groupId, section)
  if (!group || !['cancel', 'exit'].includes(String(action || '').toLowerCase())) return []
  const lineage = context?._executionLineage
  if (!lineage || String(lineage.strategy_scope || '').toLowerCase() !== 'platform') {
    const taskType = section === 'position' ? 'position_exit' : 'pending_cancel'
    return (context?._targets?.get(groupId) || [])
      .filter(target => targetMatchesPositionManagementTask(target, taskType))
  }
  const originSignalId = Number(group.original_signal_id)
  const strategyId = Number(group.strategy_id)
  if (!Number.isSafeInteger(originSignalId) || originSignalId <= 0
    || !Number.isSafeInteger(strategyId) || strategyId <= 0) return []
  const sourceUserIds = new Set((lineage.source_user_ids || []).map(Number).filter(id => id > 0))
  const rows = await queryAll(`SELECT d.id AS delivery_id, d.signal_id AS delivery_signal_id,
      d.user_id AS delivery_user_id, d.prompt_type_id AS delivery_strategy_id,
      d.symbol AS delivery_symbol, d.order_intent_id AS delivery_order_intent_id,
      d.pending_ticket AS delivery_pending_ticket, d.trade_ticket AS delivery_trade_ticket,
      d.pending_state AS delivery_pending_state,
      oi.id AS intent_id, oi.user_id AS intent_user_id, oi.trading_account_id AS intent_trading_account_id,
      oi.status AS intent_status, oi.action AS intent_action,
      outcomes.id AS outcome_id, outcomes.delivery_id AS outcome_delivery_id,
      outcomes.order_intent_id AS outcome_order_intent_id, outcomes.user_id,
      outcomes.trading_account_id, outcomes.ownership_history_id, outcomes.broker_server_key,
      outcomes.login_account, outcomes.original_symbol, outcomes.symbol, outcomes.pending_ticket,
      outcomes.position_id, outcomes.entry_direction, outcomes.system_magic,
      outcomes.attribution_status, outcomes.actual_stop_loss, outcomes.actual_take_profit,
      outcomes.status AS outcome_status,
      COALESCE(d.pending_state, origin_signals.pending_state) AS effective_pending_state,
      origin_signals.management_group_id AS origin_management_group_id,
      origin_signals.thesis_id AS origin_thesis_id,
      origin_signals.prompt_type_id AS origin_strategy_id,
      origin_signals.id AS origin_signal_id,
      theses.strategy_version, theses.strategy_scope, theses.management_group_id, theses.thesis_id
    FROM auto_signal_deliveries d
    JOIN ai_signals origin_signals ON origin_signals.id = d.signal_id
    LEFT JOIN order_intents oi ON oi.id = d.order_intent_id
    LEFT JOIN signal_outcomes outcomes
      ON outcomes.delivery_id = d.id AND outcomes.order_intent_id = d.order_intent_id
    LEFT JOIN ai_trade_theses theses ON theses.thesis_id = origin_signals.thesis_id
    WHERE d.signal_id = ? AND d.prompt_type_id = ?
    ORDER BY d.id ASC, outcomes.id ASC`, [originSignalId, strategyId])
  const byDelivery = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const deliveryId = Number(row.delivery_id)
    if (!Number.isSafeInteger(deliveryId) || deliveryId <= 0) continue
    if (!byDelivery.has(deliveryId)) byDelivery.set(deliveryId, [])
    byDelivery.get(deliveryId).push(row)
  }
  const targets = []
  for (const deliveryRows of byDelivery.values()) {
    // A delivery must resolve to exactly one outcome.  Do not select a
    // historical ticket when the lineage is duplicated or partially linked.
    if (deliveryRows.length !== 1) continue
    const row = deliveryRows[0]
    const deliveryUserId = Number(row.delivery_user_id)
    if (!deliveryUserId || sourceUserIds.has(deliveryUserId)) continue
    if (Number(row.delivery_signal_id) !== originSignalId
      || Number(row.delivery_strategy_id) !== strategyId
      || Number(row.origin_signal_id) !== originSignalId
      || Number(row.origin_strategy_id) !== strategyId
      || Number(row.strategy_version || 0) !== Number(group.strategy_version || 0)
      || String(row.origin_management_group_id || '') !== String(group.management_group_id || '')
      || String(row.origin_thesis_id || '') !== String(group.thesis_id || '')
      || stripBrokerSuffix(String(row.delivery_symbol || '')).toUpperCase()
        !== stripBrokerSuffix(String(group.standard_symbol || '')).toUpperCase()
      || Number(row.delivery_order_intent_id) <= 0
      || Number(row.intent_id) !== Number(row.delivery_order_intent_id)
      || (row.intent_status != null
        && !['succeeded', 'success'].includes(String(row.intent_status).toLowerCase()))
      || Number(row.outcome_id) <= 0
      || Number(row.outcome_order_intent_id) !== Number(row.intent_id)
      || Number(row.outcome_delivery_id || 0) !== Number(row.delivery_id)
      || Number(row.intent_user_id) !== deliveryUserId
      || Number(row.user_id) !== deliveryUserId
      || Number(row.intent_trading_account_id) !== Number(row.trading_account_id)
      || String(row.management_group_id || '') !== String(group.management_group_id || '')
      || String(row.thesis_id || '') !== String(group.thesis_id || '')) continue
    if (section === 'pending' && row.delivery_pending_ticket
      && String(row.delivery_pending_ticket) !== String(row.pending_ticket || '')) continue
    if (!['open', 'closing'].includes(String(row.outcome_status || '').toLowerCase())) continue
    const target = lineageTargetFromRow(row)
    if (targetMatchesPositionManagementTask(target, section === 'position' ? 'position_exit' : 'pending_cancel')) {
      targets.push(target)
    }
  }
  return targets
}

function managementContractVersion(value) {
  if (!value || typeof value !== 'object') return null
  const nested = value._position_management && typeof value._position_management === 'object'
    ? value._position_management.contract_version : null
  return String(value.contract_version || nested || '').trim() || null
}

function managementInferenceIdentity(value) {
  const candidate = value?.inference_id ?? value?.decision_signal_id ?? value?.signal_id
    ?? value?.evaluation_id ?? value?.id
  const numeric = Number(candidate)
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.trunc(numeric)) : null
}

function managementTaskIdentity(value) {
  const candidate = value?.task_id ?? value?.task_key ?? value?.management_task_id
  if (candidate == null || String(candidate).trim() === '') return null
  return String(candidate).trim()
}

function managementSnapshotIdentity(value) {
  const hashValue = value?.market_snapshot_hash ?? value?.snapshot_hash
  if (hashValue != null && String(hashValue).trim() !== '') {
    return `hash:${String(hashValue).trim().replace(/^sha256:/i, '')}`
  }
  const closedBar = Number(value?.closed_bar_time_utc_ms)
  if (Number.isFinite(closedBar) && closedBar > 0) return `bar:${Math.trunc(closedBar)}`
  return null
}

/**
 * Resolve the automatic exit counter from independent current-state
 * evaluations.  A repeated write of the same inference or snapshot is not a
 * new confirmation.  Explicit task identities are also required to differ;
 * rows from an older or unknown contract remain audit-only during a rolling
 * upgrade and cannot contribute a confirmation.
 */
export function resolveAutomaticExitConfirmation(current, previous = null) {
  const validationStatus = current?.validation_source === 'server_fail_closed' ? 'invalid' : 'valid'
  const action = String(current?.action || '').toLowerCase()
  const currentContract = managementContractVersion(current)
  const previousContract = managementContractVersion(previous)
  if (currentContract && currentContract !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
    return { validation_status:'invalid', confirmation_count:0, reset_reason:'position_management_contract_version_mismatch' }
  }
  if (validationStatus !== 'valid') {
    return { validation_status:'invalid', confirmation_count:0, reset_reason:'invalid_inference_output' }
  }
  if (action !== 'exit') {
    return { validation_status:'valid', confirmation_count:0, reset_reason:'automatic_inference_hold' }
  }
  if (previousContract && previousContract !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
    return { validation_status:'valid', confirmation_count:1, reset_reason:'contract_not_compatible' }
  }
  if (previous && !previousContract) {
    // Legacy/unknown evaluation rows are audit history only.  They cannot be
    // paired with a current-state inference for automatic execution.
    return { validation_status:'valid', confirmation_count:1, reset_reason:'contract_not_compatible' }
  }
  const previousExit = String(previous?.validation_status || '').toLowerCase() === 'valid'
    && String(previous?.action || '').toLowerCase() === 'exit'
  if (!previousExit) {
    return { validation_status:'valid', confirmation_count:1, reset_reason:null }
  }

  // Confirmation must come from the immediately previous actual closed bar
  // in the current strategy window.  Do not infer adjacency from a fixed
  // timeframe duration: weekends, holidays and broker data gaps are valid
  // reasons for UTC timestamps to be farther apart.
  const previousEvaluationBar = Number(previous?.closed_bar_time_utc_ms)
  const currentPreviousBar = Number(current?.previous_closed_bar_time_utc_ms)
  if (!Number.isFinite(previousEvaluationBar) || previousEvaluationBar <= 0
    || !Number.isFinite(currentPreviousBar) || currentPreviousBar <= 0
    || previousEvaluationBar !== currentPreviousBar) {
    return { validation_status:'valid', confirmation_count:1,
      reset_reason:'automatic_confirmation_bar_gap' }
  }

  const currentInference = managementInferenceIdentity(current)
  const previousInference = managementInferenceIdentity(previous)
  const currentTask = managementTaskIdentity(current)
  const previousTask = managementTaskIdentity(previous)
  const currentSnapshot = managementSnapshotIdentity(current)
  const previousSnapshot = managementSnapshotIdentity(previous)
  const sameInference = Boolean(currentInference && previousInference && currentInference === previousInference)
  const sameTask = Boolean(currentTask && previousTask && currentTask === previousTask)
  const sameSnapshot = Boolean(currentSnapshot && previousSnapshot && currentSnapshot === previousSnapshot)
  const distinctInference = Boolean(currentInference && previousInference && !sameInference)
  const distinctSnapshot = Boolean(currentSnapshot && previousSnapshot && !sameSnapshot)

  // Missing identity is intentionally fail-closed for the counter.  The
  // first candidate remains visible, but an unknown/duplicate event cannot
  // promote it to an executable exit.
  if (sameInference || sameTask || sameSnapshot || !distinctInference || !distinctSnapshot) {
    return {
      validation_status:'valid', confirmation_count:1,
      reset_reason:'automatic_confirmation_identity_not_distinct',
    }
  }
  return {
    validation_status:'valid',
    confirmation_count:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    reset_reason:null,
  }
}

async function recordAutomaticPositionEvaluation({ signalId, context, target, evaluation, inferenceSource } = {}) {
  const now = beijingNow()
  const originalSymbol = String(target.original_symbol || target.symbol || target.standard_symbol || '')
  const standardSymbol = target.standard_symbol || stripBrokerSuffix(originalSymbol).toUpperCase()
  const validationStatus = evaluation.validation_source === 'server_fail_closed' ? 'invalid' : 'valid'
  const storedEvaluation = {
    ...evaluation,
    contract_version:managementContractVersion(evaluation) || POSITION_MANAGEMENT_CONTRACT_VERSION,
  }
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
    null, text(evaluation.reason, 1000) || null,
    JSON.stringify(evaluation.evidence_refs || []), JSON.stringify(storedEvaluation),
    context.as_of.decision_timeframe, context.as_of.closed_bar_time_utc_ms,
    String(context.as_of.market_snapshot_hash).replace(/^sha256:/, ''), inferenceSource, now,
  ])
  if (!Number(result?.insertId)) return null
  const evaluationId = Number(result.insertId)
  const previous = inferenceSource === 'automatic_scheduler'
    ? await queryOne(`SELECT id, decision_signal_id, action, validation_status,
        consecutive_exit_count, market_snapshot_hash, closed_bar_time_utc_ms,
        model_evaluation_json, created_at
      FROM ai_position_management_evaluations
      WHERE outcome_id = ? AND management_group_id = ? AND inference_source = 'automatic_scheduler' AND id < ?
      ORDER BY id DESC LIMIT 1`, [target.outcome_id, target.management_group_id, evaluationId])
    : null
  const confirmation = inferenceSource === 'automatic_scheduler'
    ? resolveAutomaticExitConfirmation({ ...evaluation,
      inference_id:String(signalId), decision_signal_id:Number(signalId),
      market_snapshot_hash:context.as_of.market_snapshot_hash,
      closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms,
      previous_closed_bar_time_utc_ms:context?._diagnostics?.previous_closed_bar_time_utc_ms,
      contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    }, {
      ...previous,
      ...json(previous?.model_evaluation_json, {}),
      contract_version:managementContractVersion(json(previous?.model_evaluation_json, {})),
    })
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
    inference_id:String(signalId),
    market_snapshot_hash:context.as_of.market_snapshot_hash,
    closed_bar_time_utc_ms:context.as_of.closed_bar_time_utc_ms,
    previous_closed_bar_time_utc_ms:context?._diagnostics?.previous_closed_bar_time_utc_ms || null,
    contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
    created_at:now,
  }
}

function automaticInferenceEvidence(record) {
  const previousContract = managementContractVersion(json(record.previous?.model_evaluation_json, {}))
  const previous = record.confirmation_count >= AUTO_EXIT_CONFIRMATIONS_REQUIRED
    && previousContract === POSITION_MANAGEMENT_CONTRACT_VERSION
    && String(record.previous?.action).toLowerCase() === 'exit'
    && String(record.previous?.validation_status).toLowerCase() === 'valid' ? record.previous : null
  const evaluationIds = [previous?.id, record.id].filter(Boolean).map(Number)
  const decisionSignalIds = [previous?.decision_signal_id, record.decision_signal_id].filter(Boolean).map(Number)
  return {
    status:record.confirmation_count >= AUTO_EXIT_CONFIRMATIONS_REQUIRED ? 'confirmed' : 'candidate',
    source:'automatic_inference_consecutive',
    confirmation_count:record.confirmation_count,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    evaluation_ids:evaluationIds,
    decision_signal_ids:decisionSignalIds,
    snapshot_hashes:[previous?.market_snapshot_hash, record.market_snapshot_hash]
      .filter(Boolean).map(value => String(value).replace(/^sha256:/i, '')),
    closed_bar_times_utc_ms:[previous?.closed_bar_time_utc_ms, record.closed_bar_time_utc_ms]
      .filter(value => Number.isFinite(Number(value))).map(value => Number(value)),
    contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
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
  const isBarGapReset = record.reset_reason === 'automatic_confirmation_bar_gap'
  const evidence = {
    status:'reset',
    source:isBarGapReset
      ? 'automatic_confirmation_bar_gap'
      : (record.validation_status === 'invalid' ? 'invalid_inference_output' : 'automatic_inference_hold'),
    confirmation_count:0,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    reset_evaluation_id:record.id,
    reset_decision_signal_id:record.decision_signal_id,
    evaluation_ids:evaluationIds,
    decision_signal_ids:decisionSignalIds,
    ...(isBarGapReset ? {
      previous_closed_bar_time_utc_ms:record.previous?.closed_bar_time_utc_ms || null,
      current_previous_closed_bar_time_utc_ms:record.previous_closed_bar_time_utc_ms || null,
    } : {}),
  }
  const result = await queryRun(`UPDATE ai_position_management_tasks
    SET status = 'HELD', evidence_validation_json = ?, confirmation_count = 0,
      state_version = state_version + 1, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'CANDIDATE'`, [JSON.stringify(evidence), now, now, task.id])
  if (Number(result?.changes ?? result?.affectedRows ?? 0) !== 1) return null
  const summary = isBarGapReset
    ? '当前行情窗口存在闭合K线缺口，旧平仓候选已安全结束'
    : (record.validation_status === 'invalid'
      ? '本轮自动推理结果无效，连续平仓确认已中断'
      : '本轮自动推理建议继续持有，连续平仓确认已清零')
  const eventType = isBarGapReset
    ? 'automatic_confirmation_bar_gap'
    : 'automatic_confirmation_reset'
  await queryRun(`INSERT INTO ai_position_management_events
    (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
    VALUES (?, 'CANDIDATE', 'HELD', ?, ?, ?, 'model', ?)`, [
    task.id, eventType, summary, JSON.stringify({ evaluation, evidence }), now,
  ])
  const updated = { ...task, status:'HELD', state_version:Number(task.state_version || 1) + 1,
    confirmation_count:0, evidence_validation_json:JSON.stringify(evidence), updated_at:now }
  broadcastPositionManagementTask(updated, eventType)
  return updated
}

async function createAutomaticExitTask({ signalId, context, target, evaluation, mode, record, evidence } = {}) {
  const now = beijingNow()
  const originalSymbol = String(target.original_symbol || target.symbol || target.standard_symbol || '')
  const confirmed = record.confirmation_count >= AUTO_EXIT_CONFIRMATIONS_REQUIRED
  const status = confirmed ? 'EVIDENCE_CONFIRMED' : 'CANDIDATE'
  const storedEvaluation = {
    ...evaluation,
    contract_version:managementContractVersion(evaluation) || POSITION_MANAGEMENT_CONTRACT_VERSION,
  }
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
    evaluation.reversal_candidate ? 1 : 0, JSON.stringify(storedEvaluation), JSON.stringify(evidence),
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
    thesis_id:target.thesis_id, origin_signal_id:target.origin_signal_id || null,
    decision_signal_id:Number(signalId), outcome_id:target.outcome_id,
    candidate_action:'exit', confirmation_count:record.confirmation_count,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED, updated_at:now }
  broadcastPositionManagementTask(task, confirmed ? 'automatic_confirmation_completed' : 'automatic_confirmation_recorded')
  return task
}

async function advanceAutomaticExitCandidate({ signalId, context, target, evaluation, mode, record } = {}) {
  const evidence = automaticInferenceEvidence(record)
  const storedEvaluation = {
    ...evaluation,
    contract_version:managementContractVersion(evaluation) || POSITION_MANAGEMENT_CONTRACT_VERSION,
  }
  let task = await queryOne(`SELECT * FROM ai_position_management_tasks
    WHERE outcome_id = ? AND management_group_id = ? AND task_type = 'position_exit'
      AND status NOT IN ('HELD','EXPIRED','REJECTED','FAILED','COMPLETED','EXIT_ONLY_COMPLETED','MANUAL_REVIEW')
    ORDER BY id DESC LIMIT 1`, [target.outcome_id, target.management_group_id])
  if (task && task.status !== 'CANDIDATE') return null
  if (task && task.status === 'CANDIDATE') {
    const taskContract = managementContractVersion(parseManagementJson(task.model_evaluation_json, {}))
    if (taskContract !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
      // A prior-contract candidate is audit history, never the second half of a
      // current-state confirmation.  Retire it before creating a fresh task
      // so two historical candidates cannot execute the same position.
      const now = beijingNow()
      const retired = await queryRun(`UPDATE ai_position_management_tasks
        SET status = 'EXPIRED', completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ? AND status = 'CANDIDATE'`, [now, now, task.id])
      if (Number(retired?.changes ?? retired?.affectedRows ?? 0) !== 1) return null
      await queryRun(`INSERT INTO ai_position_management_events
        (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
        VALUES (?, 'CANDIDATE', 'EXPIRED', 'management_contract_upgraded',
          '旧版持仓判断已结束，后续仅使用当前行情重新确认', ?, 'system', ?)`, [
        task.id, JSON.stringify({
          previous_contract_version:taskContract || 'unknown',
          current_contract_version:POSITION_MANAGEMENT_CONTRACT_VERSION,
        }), now,
      ])
      task = null
    }
  }
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
    evaluation.reversal_candidate ? 1 : 0, JSON.stringify(storedEvaluation), JSON.stringify(evidence),
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
    decision_signal_id:signalId, model_evaluation_json:JSON.stringify(storedEvaluation),
    evidence_validation_json:JSON.stringify(evidence), confirmation_count:AUTO_EXIT_CONFIRMATIONS_REQUIRED,
    required_confirmations:AUTO_EXIT_CONFIRMATIONS_REQUIRED, updated_at:now }
  broadcastPositionManagementTask(updated, 'automatic_confirmation_completed')
  return updated
}

function normalizePersistedManagementEvaluation(evaluation, group, section) {
  const action = String(evaluation?.action || '').trim().toLowerCase()
  const alignment = normalizeMarketAlignment(evaluation?.market_alignment)
  const reason = text(evaluation?.reason, 1000)
  const reasonCode = String(section === 'position'
    ? evaluation?.exit_reason_code : evaluation?.cancel_reason_code || '').trim().toLowerCase()
  const actionAllowed = section === 'position'
    ? ['hold', 'exit'].includes(action)
    : ['keep', 'cancel'].includes(action)
  const executionAction = action === 'exit' || action === 'cancel'
  const reasonCodeValid = executionAction
    ? MANAGEMENT_REASON_CODE.test(reasonCode)
    : !reasonCode || reasonCode === 'null' || reasonCode === 'none'
  const invalid = !groupManagementFactsAvailable(group) || !alignment || !actionAllowed
    || !reason || !reasonCodeValid
  if (!invalid) return { ...evaluation, thesis_id:group?.thesis_id || null,
    origin_signal_id:Number(group?.original_signal_id) || null, market_alignment:alignment }
  if (section === 'position') return {
    ...safePositionEvaluation(
      evaluation?.management_group_id, group?.thesis_id,
      '当前决策证据或终端事实不可用，或模型理由不符合行情一致性合同，服务端按安全默认继续持有',
    ), origin_signal_id:Number(group?.original_signal_id) || null,
  }
  return {
    ...safePendingEvaluation(evaluation?.management_group_id, group?.thesis_id,
      '当前决策证据或终端事实不可用，或模型理由不符合行情一致性合同，服务端按安全默认继续保留挂单'),
    origin_signal_id:Number(group?.original_signal_id) || null,
  }
}

export async function persistPositionManagementEvaluations({
  signalId, context, management, inferenceSource = 'manual_analysis', synchronousPendingCancelGroupIds = null,
} = {}) {
  if (!signalId || !context?._targets || !management) return []
  if (context.contract_version
    && String(context.contract_version) !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
    throw new Error('position_management_contract_version_mismatch')
  }
  const suppliedContract = managementContractVersion(management)
  if (suppliedContract && suppliedContract !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
    throw new Error('position_management_contract_version_mismatch')
  }
  const positionEvaluations = Array.isArray(management.position_evaluations)
    ? management.position_evaluations : []
  const pendingEvaluations = Array.isArray(management.pending_evaluations)
    ? management.pending_evaluations : []
  for (const evaluation of [...positionEvaluations, ...pendingEvaluations]) {
    const evaluationContract = managementContractVersion(evaluation)
    if (evaluationContract && evaluationContract !== POSITION_MANAGEMENT_CONTRACT_VERSION) {
      throw new Error('position_management_contract_version_mismatch')
    }
  }
  const synchronousGroups = synchronousPendingCancelGroupIds instanceof Set
    ? synchronousPendingCancelGroupIds
    : new Set(Array.isArray(synchronousPendingCancelGroupIds) ? synchronousPendingCancelGroupIds : [])
  const pendingCandidates = pendingEvaluations
    .map(item => normalizePersistedManagementEvaluation(item,
      (context.pending_groups || []).find(group => String(group.management_group_id) === String(item?.management_group_id)),
      'pending'))
    .filter(item => item.action === 'cancel'
      && !synchronousGroups.has(String(item?.management_group_id || '')))
    .map(item => ({ ...item, taskType:'pending_cancel' }))
  const resolvedTargets = new Map()
  const resolveFor = async (item, section, action) => {
    const groupId = String(item?.management_group_id || '')
    if (!groupId) return []
    if (resolvedTargets.has(`${section}:${groupId}`)) return resolvedTargets.get(`${section}:${groupId}`)
    const targets = await resolvePositionManagementExecutionTargets({
      context, groupId, section, action,
    })
    resolvedTargets.set(`${section}:${groupId}`, targets)
    return targets
  }
  const allTargets = []
  for (const item of positionEvaluations) {
    const normalized = normalizePersistedManagementEvaluation(item,
      executionGroup(context, item?.management_group_id, 'position'), 'position')
    if (normalized.action !== 'exit') continue
    allTargets.push(...await resolveFor(item, 'position', 'exit'))
  }
  for (const item of pendingCandidates) {
    allTargets.push(...await resolveFor(item, 'pending', 'cancel'))
  }
  const modes = await resolveModes(allTargets)
  const created = []

  for (const evaluation of positionEvaluations) {
    const normalizedEvaluation = normalizePersistedManagementEvaluation(evaluation,
      (context.position_groups || []).find(group => String(group.management_group_id) === String(evaluation?.management_group_id)),
      'position')
    const targets = normalizedEvaluation.action === 'exit'
      ? (resolvedTargets.get(`position:${String(evaluation.management_group_id || '')}`) || [])
      : []
    for (const target of targets) {
      const mode = resolvePositionManagementTaskMode('position_exit',
        modes.byUser.get(Number(target.user_id)) || 'auto_exit', modes.control)
      if (mode === 'display') continue
      const record = await recordAutomaticPositionEvaluation({
        signalId, context, target, evaluation:normalizedEvaluation, inferenceSource,
      })
      if (!record) continue
      if (inferenceSource !== 'automatic_scheduler') continue
      if (record.reset_reason === 'automatic_confirmation_bar_gap') {
        const resetTask = await resetAutomaticExitCandidate(target, record, normalizedEvaluation)
        if (resetTask) created.push(resetTask)
      }
      const task = record.validation_status !== 'valid' || record.action !== 'exit'
        ? await resetAutomaticExitCandidate(target, record, normalizedEvaluation)
        : await advanceAutomaticExitCandidate({ signalId, context, target,
          evaluation:normalizedEvaluation, mode, record })
      if (task) created.push(task)
    }
  }

  for (const evaluation of pendingCandidates) {
    const targets = resolvedTargets.get(`pending:${String(evaluation.management_group_id || '')}`) || []
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
        evaluation.action, evaluation.reversal_candidate ? 1 : 0,
        JSON.stringify({ ...evaluation,
          contract_version:managementContractVersion(evaluation) || POSITION_MANAGEMENT_CONTRACT_VERSION }),
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
        thesis_id:target.thesis_id, origin_signal_id:target.origin_signal_id || null,
        decision_signal_id:Number(signalId), outcome_id:target.outcome_id,
        candidate_action:evaluation.action,
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

function parseManagementJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function managementNumber(value) {
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : null
}

function managementText(value, max = 500) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max)
  return text(value, max)
}

function managementTaskSummary(task) {
  if (!task) return null
  const id = managementNumber(task.id)
  if (!id) return null
  return {
    id,
    task_type:text(task.task_type, 32) || null,
    status:text(task.status, 40).toUpperCase() || null,
    execution_mode:text(task.execution_mode, 20) || null,
    updated_at:task.updated_at || null,
  }
}

function managementTaskEvidence(task) {
  return parseManagementJson(task?.evidence_validation_json, {})
}

function managementTaskModel(task) {
  return parseManagementJson(task?.model_evaluation_json, {})
}

function taskContainsEvaluation(task, evaluation, signalId) {
  if (!task || !evaluation) return false
  const evidence = managementTaskEvidence(task)
  const evaluationId = managementNumber(evaluation.id)
  const evaluationIds = [
    ...(Array.isArray(evidence.evaluation_ids) ? evidence.evaluation_ids : []),
    evidence.reset_evaluation_id,
  ].map(managementNumber).filter(Boolean)
  const signalIds = [
    ...(Array.isArray(evidence.decision_signal_ids) ? evidence.decision_signal_ids : []),
    evidence.reset_decision_signal_id,
  ].map(managementNumber).filter(Boolean)
  return (evaluationId && evaluationIds.includes(evaluationId))
    || (Number(signalId) > 0 && signalIds.includes(Number(signalId)))
}

function taskResetByEvaluation(task, evaluation, signalId) {
  if (!task || !evaluation) return false
  const evidence = managementTaskEvidence(task)
  const evaluationId = managementNumber(evaluation.id)
  const resetEvaluationId = managementNumber(evidence.reset_evaluation_id)
  const resetSignalId = managementNumber(evidence.reset_decision_signal_id)
  const evaluationIds = Array.isArray(evidence.evaluation_ids)
    ? evidence.evaluation_ids.map(managementNumber).filter(Boolean) : []
  return (evaluationId && resetEvaluationId === evaluationId)
    || (Number(signalId) > 0 && resetSignalId === Number(signalId))
    || (evaluationId && evaluationIds.includes(evaluationId) && evidence.status === 'reset')
}

function taskForManagementAction(spec, evaluation, tasks, signalId) {
  const candidates = (tasks || []).filter(task => {
    if (String(task?.task_type || '') !== spec.task_type) return false
    if (spec.management_group_id && String(task.management_group_id || '') !== spec.management_group_id) return false
    if (evaluation?.outcome_id && Number(task.outcome_id) !== Number(evaluation.outcome_id)) return false
    return true
  })
  if (!candidates.length) return null
  const exact = candidates.find(task => taskContainsEvaluation(task, evaluation, signalId))
  if (exact) return exact
  const signalMatch = candidates.find(task => [task.decision_signal_id, task.origin_signal_id]
    .map(managementNumber).includes(Number(signalId)))
  return signalMatch || null
}

function managementTargetTicket(spec, task, evaluation = null) {
  const taskTicket = spec.task_type === 'pending_cancel'
    ? task?.target_pending_ticket
    : task?.target_position_id
  const evaluationTicket = spec.task_type === 'position_exit' ? evaluation?.position_id : null
  const value = taskTicket || evaluationTicket
  return managementText(value, 96) || null
}

function managementReason(spec, evaluation, task) {
  const model = managementTaskModel(task)
  return text(spec.reason || evaluation?.reason || model.reason || model.message, 1000) || null
}

/**
 * Build the user-visible management contribution of one inference.  The
 * decision payload is authoritative for which actions were proposed; rows in
 * the two management tables only enrich that proposal with confirmation and
 * current task state.  This keeps the first inference's effect stable even
 * after its task advances to a terminal state.
 */
export function buildSignalManagementActions({
  signalId = null, management = null, evaluations = [], tasks = [],
} = {}) {
  const source = management?.position_management && typeof management.position_management === 'object'
    ? management.position_management : management
  if (!source || typeof source !== 'object' || Array.isArray(source)) return []
  const signalNumber = managementNumber(signalId)
  const specs = [
    ...(Array.isArray(source.pending_evaluations) ? source.pending_evaluations : [])
      .filter(item => String(item?.action || '').toLowerCase() === 'cancel')
      .map(item => ({ ...item, task_type:'pending_cancel', action_type:'pending_cancel', action:'cancel' })),
    ...(Array.isArray(source.position_evaluations) ? source.position_evaluations : [])
      .filter(item => ['exit', 'hold'].includes(String(item?.action || '').toLowerCase()))
      .map(item => ({ ...item, task_type:'position_exit', action_type:'position_exit', action:String(item.action).toLowerCase() })),
  ]
  const result = []
  for (const spec of specs) {
    const matchingEvaluations = (evaluations || []).filter(row =>
      String(row?.management_group_id || '') === String(spec.management_group_id || '')
      && (!spec.thesis_id || !row?.thesis_id || String(row.thesis_id) === String(spec.thesis_id)))
    const directTasks = (tasks || []).filter(task =>
      String(task?.task_type || '') === spec.task_type
      && (!spec.management_group_id || String(task.management_group_id || '') === spec.management_group_id)
      && signalNumber
      && [task.decision_signal_id, task.origin_signal_id]
        .map(managementNumber).includes(signalNumber))
    const targets = matchingEvaluations.length
      ? matchingEvaluations.map(evaluation => ({
        evaluation,
        task:taskForManagementAction(spec, evaluation, tasks, signalNumber),
      }))
      : directTasks.length ? directTasks.map(task => ({ evaluation:null, task })) : [{ evaluation:null, task:null }]

    for (const { evaluation, task } of targets) {
      const validationStatus = String(evaluation?.validation_status || '').toLowerCase() === 'invalid' ? 'invalid' : 'valid'
      const count = Math.max(0, Number(evaluation?.consecutive_exit_count || 0))
      let inferenceEffect = 'display_only'
      let confirmationCount = spec.task_type === 'pending_cancel' ? 1 : count
      const requiredConfirmations = spec.task_type === 'pending_cancel' ? 1 : AUTO_EXIT_CONFIRMATIONS_REQUIRED

      if (spec.task_type === 'pending_cancel') {
        // A persisted task proves that this one-round decision entered the
        // executable management domain. Without it the decision remains a
        // display-only recommendation (for example, platform display mode).
        inferenceEffect = task ? 'first_confirmation' : 'display_only'
      } else if (spec.action === 'hold') {
        const reset = taskResetByEvaluation(task, evaluation, signalNumber)
        if (!reset) continue
        inferenceEffect = validationStatus === 'invalid' ? 'invalid_reset' : 'confirmation_reset'
        confirmationCount = 0
      } else if (evaluation) {
        if (validationStatus === 'invalid') {
          inferenceEffect = taskResetByEvaluation(task, evaluation, signalNumber) ? 'invalid_reset' : 'display_only'
          confirmationCount = 0
        } else if (count >= requiredConfirmations) {
          inferenceEffect = 'confirmation_completed'
          confirmationCount = requiredConfirmations
        } else if (count === 1) {
          inferenceEffect = 'first_confirmation'
          confirmationCount = 1
        }
      }

      const taskSummary = managementTaskSummary(task)
      const targetTicket = managementTargetTicket(spec, task, evaluation)
      result.push({
        action_type:spec.action_type,
        task_type:spec.task_type,
        action:spec.action,
        management_group_id:text(spec.management_group_id, 80) || null,
        thesis_id:text(spec.thesis_id, 80) || text(evaluation?.thesis_id, 80) || null,
        signal_id:signalNumber,
        evaluation_id:managementNumber(evaluation?.id),
        market_alignment:normalizeMarketAlignment(spec.market_alignment)
          || normalizeMarketAlignment(evaluation?.market_alignment) || null,
        cancel_reason_code:spec.task_type === 'pending_cancel'
          ? (String(spec.cancel_reason_code || '').toLowerCase() || null) : null,
        exit_reason_code:spec.task_type === 'position_exit'
          ? (String(spec.exit_reason_code || '').toLowerCase() || null) : null,
        ticket:targetTicket,
        target_ticket:targetTicket,
        reason:managementReason(spec, evaluation, task),
        validation_status:validationStatus,
        inference_effect:inferenceEffect,
        confirmation_count:confirmationCount,
        required_confirmations:requiredConfirmations,
        task_id:taskSummary?.id || null,
        task_status:taskSummary?.status || null,
        task:taskSummary,
      })
    }
  }
  return result.slice(0, 50)
}

/**
 * Load management evidence for a signal while enforcing the requested user
 * scope.  Missing/older management tables degrade to the decision-only
 * payload so signal detail remains usable during rolling upgrades.
 */
export async function loadSignalManagementActions(userId, signalId, {
  management = null,
} = {}) {
  const scopedUserId = Number(userId)
  const scopedSignalId = Number(signalId)
  if (!Number.isInteger(scopedUserId) || scopedUserId <= 0
    || !Number.isInteger(scopedSignalId) || scopedSignalId <= 0) return []

  // The caller must provide the already-authorized decision payload.  Do not
  // fetch an unscoped signal row here: shared/observer signals can be owned by
  // another account even though the current user has a delivery for them.
  const source = management
  const decision = source?.position_management && typeof source.position_management === 'object'
    ? source.position_management : source
  const hasVisibleDecision = decision && typeof decision === 'object' && !Array.isArray(decision)
    && ((Array.isArray(decision.pending_evaluations) && decision.pending_evaluations
      .some(item => String(item?.action || '').toLowerCase() === 'cancel'))
      || (Array.isArray(decision.position_evaluations) && decision.position_evaluations
        .some(item => ['exit', 'hold'].includes(String(item?.action || '').toLowerCase()))))
  if (!hasVisibleDecision) return []

  let evaluations = []
  try {
    evaluations = await queryAll(`SELECT * FROM ai_position_management_evaluations
      WHERE user_id = ? AND decision_signal_id = ?
      ORDER BY id ASC LIMIT 100`, [scopedUserId, scopedSignalId])
  } catch (error) {
    console.warn(`[PositionManagement] Failed to load evaluations for signal ${scopedSignalId}:`, error.message)
    evaluations = []
  }
  evaluations = (evaluations || []).filter(row => row?.user_id == null || Number(row.user_id) === scopedUserId)

  const groups = [...new Map((evaluations || []).map(row => [
    `${Number(row?.outcome_id) || 0}:${String(row?.management_group_id || '')}`,
    [Number(row?.outcome_id) || 0, String(row?.management_group_id || '')],
  ])).values()].filter(([outcomeId, groupId]) => outcomeId > 0 && groupId)
  const taskConditions = [
    'tasks.decision_signal_id = ?',
    'tasks.origin_signal_id = ?',
    'outcomes.signal_id = ?',
  ]
  const taskParams = [scopedSignalId, scopedSignalId, scopedSignalId]
  for (const [outcomeId, groupId] of groups) {
    taskConditions.push('(tasks.outcome_id = ? AND tasks.management_group_id = ?)')
    taskParams.push(outcomeId, groupId)
  }
  let tasks = []
  try {
    tasks = await queryAll(`SELECT tasks.*, outcomes.position_id AS target_position_id,
        outcomes.pending_ticket AS target_pending_ticket
      FROM ai_position_management_tasks tasks
      LEFT JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
      WHERE tasks.user_id = ? AND tasks.task_type IN ('position_exit','pending_cancel')
        AND (${taskConditions.join(' OR ')})
      ORDER BY tasks.updated_at DESC, tasks.id DESC LIMIT 100`, [scopedUserId, ...taskParams])
  } catch (error) {
    console.warn(`[PositionManagement] Failed to load tasks for signal ${scopedSignalId}:`, error.message)
    tasks = []
  }
  tasks = (tasks || []).filter(row => row?.user_id == null || Number(row.user_id) === scopedUserId)

  return buildSignalManagementActions({
    signalId:scopedSignalId, management:source, evaluations, tasks,
  })
}

export function broadcastPositionManagementTask(task, reason = 'updated') {
  const payload = { type:'position_management_task_updated', reason, task:{
    id:Number(task.id), status:task.status, state_version:Number(task.state_version || 1),
    execution_mode:task.execution_mode, task_type:task.task_type,
    management_group_id:task.management_group_id, thesis_id:task.thesis_id,
    origin_signal_id:managementNumber(task.origin_signal_id),
    decision_signal_id:managementNumber(task.decision_signal_id),
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
