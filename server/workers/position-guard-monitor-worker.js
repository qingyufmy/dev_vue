import crypto from 'node:crypto'
import { beijingNow, parseBeijing, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { getBridgeDataRoute, getBridgeGeneration } from '../bridge-ws.js'
import { mt5Bridge } from '../routes/ai/market-data.js'
import { getPlatformRates } from '../routes/ai/platform-market-data.js'
import { evaluatePositionGuard } from '../routes/ai/position-guard-engine.js'
import { getPositionGuardQuote, getPositionGuardQuoteCacheMetrics } from '../routes/ai/position-guard-quote-cache.js'
import {
  getPositionGuardGlobalControl,
  listEnabledPositionGuardAccounts,
} from '../routes/ai/position-guard.js'
import { requestPositionManagementWorkerRun } from '../routes/ai/position-management-worker.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'

const SYSTEM_MAGIC = 234000
const ACTIVE_INTERVAL_MS = 5_000
const IDLE_INTERVAL_MS = 30_000
const OFFLINE_INTERVAL_MS = 60_000
const CONTRACT_CACHE_MS = 10 * 60_000
const TERMINAL_TASK_STATES = new Set([
  'HELD', 'EXPIRED', 'REJECTED', 'FAILED', 'COMPLETED', 'EXIT_ONLY_COMPLETED', 'MANUAL_REVIEW',
])

let workerTimer = null
let workerRunning = false
let wakeQueued = false
const accountNextCheck = new Map()
const contractCache = new Map()
const runtimeStatus = {
  installed:true,
  running:false,
  interval_ms:ACTIVE_INTERVAL_MS,
  last_started_at:null,
  last_finished_at:null,
  last_error:null,
  last_skip_reason:'not_started',
  enabled_accounts:0,
  active_accounts:0,
  evaluated_positions:0,
  created_tasks:0,
}

const text = value => String(value ?? '').trim()
const upper = value => text(value).toUpperCase()
const number = value => Number.isFinite(Number(value)) ? Number(value) : null
const parseJson = (value, fallback = null) => {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}
const stableJson = value => JSON.stringify(canonicalize(value))
const digest = value => crypto.createHash('sha256').update(stableJson(value)).digest('hex')

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function accountKey(account) {
  return `${Number(account.user_id)}:${Number(account.trading_account_id)}`
}

function routeParams(route) {
  return {
    terminal_instance_id:route.terminal_instance_id,
    account_ref:route.account_ref,
  }
}

export function positionGuardBusinessDate(observedAtUtcMsc, timezoneOffsetMinutes) {
  const observed = Number(observedAtUtcMsc)
  if (timezoneOffsetMinutes === null || timezoneOffsetMinutes === undefined
    || timezoneOffsetMinutes === '') return null
  const offset = Number(timezoneOffsetMinutes)
  if (!Number.isSafeInteger(observed) || observed <= 0 || !Number.isInteger(offset)
    || offset < -840 || offset > 840) return null
  return new Date(observed + offset * 60_000).toISOString().slice(0, 10)
}

export function selectPositionGuardD1Window(ratesResult) {
  if (ratesResult?.status !== 'success' || !Array.isArray(ratesResult.rates)) {
    return { ok:false, code:'position_guard_d1_unavailable' }
  }
  const rates = ratesResult.rates
    .filter(rate => Number.isSafeInteger(Number(rate?.time_utc_msc))
      && Number(rate?.time_utc_msc) > 0
      && [rate?.high, rate?.low, rate?.close].every(value => Number.isFinite(Number(value))))
    .sort((left, right) => Number(left.time_utc_msc) - Number(right.time_utc_msc))
  if (!rates.length) return { ok:false, code:'position_guard_d1_unavailable' }
  const lastClosed = ratesResult.market_meta?.last_bar_closed === true
  const previous = lastClosed ? rates.at(-1) : rates.at(-2)
  const current = lastClosed ? null : rates.at(-1)
  if (!previous) return { ok:false, code:'position_guard_d1_not_ready' }
  const previousOpen = Number(previous.time_utc_msc)
  const currentOpen = current ? Number(current.time_utc_msc) : previousOpen + 86_400_000
  if (!Number.isSafeInteger(currentOpen) || currentOpen <= previousOpen) {
    return { ok:false, code:'position_guard_d1_window_invalid' }
  }
  return {
    ok:true,
    d1:{
      ready:true,
      high:Number(previous.high),
      low:Number(previous.low),
      close:Number(previous.close),
      previous_open_at:previousOpen,
      current_open_at:currentOpen,
    },
    previous_open_utc_msc:previousOpen,
    current_open_utc_msc:currentOpen,
    market_meta:ratesResult.market_meta || {},
  }
}

function normalizePosition(outcome, target, quote) {
  const direction = text(target.type || outcome.entry_direction).toLowerCase()
  return {
    ticket:text(target.ticket),
    symbol:text(target.symbol),
    direction,
    open_price:Number(target.price_open),
    current_price:direction === 'buy' ? Number(quote.bid) : Number(quote.ask),
    volume:Number(target.volume),
    stop_loss:Number(target.sl || 0) || null,
    take_profit:Number(target.tp || 0) || null,
  }
}

function normalizeContract(snapshot) {
  const instrument = snapshot?.instrument || snapshot || {}
  return {
    digits:Number(instrument.digits),
    point:Number(instrument.point),
    trade_tick_size:Number(instrument.trade_tick_size || instrument.tick_size || instrument.point),
    volume_min:Number(instrument.volume_min),
    volume_step:Number(instrument.volume_step),
    trade_stops_level:Number(instrument.trade_stops_level || instrument.stops_level || 0),
    trade_freeze_level:Number(instrument.trade_freeze_level || instrument.freeze_level || 0),
  }
}

export function exactPositionGuardTarget(outcome, inventory) {
  if (text(outcome.status).toLowerCase() !== 'open'
    || text(outcome.attribution_status).toLowerCase() !== 'attributed'
    || Number(outcome.external_intervention || 0) !== 0
    || Number(outcome.system_magic || 0) !== SYSTEM_MAGIC
    || !text(outcome.position_id)) return null
  const target = (inventory.positions || []).find(position => text(position.ticket) === text(outcome.position_id))
  if (!target || Number(target.magic || 0) !== SYSTEM_MAGIC
    || stripBrokerSuffix(text(target.symbol)).toUpperCase()
      !== stripBrokerSuffix(text(outcome.original_symbol || outcome.symbol)).toUpperCase()
    || text(target.type).toLowerCase() !== text(outcome.entry_direction).toLowerCase()
    || !Number.isFinite(Number(target.volume)) || Number(target.volume) <= 0
    || !Number.isFinite(Number(target.price_open)) || Number(target.price_open) <= 0) return null
  return target
}

async function loadEligibleOutcomes(account) {
  return queryAll(`SELECT outcomes.*
    FROM signal_outcomes outcomes
    WHERE outcomes.user_id = ? AND outcomes.trading_account_id = ?
      AND outcomes.ownership_history_id = ? AND outcomes.status = 'open'
      AND outcomes.attribution_status = 'attributed'
      AND outcomes.external_intervention = 0 AND outcomes.position_id IS NOT NULL
      AND outcomes.system_magic = ?
      AND outcomes.strategy_id IS NOT NULL AND outcomes.strategy_id > 0
      AND outcomes.thesis_id IS NOT NULL AND outcomes.thesis_id <> ''
      AND outcomes.management_group_id IS NOT NULL AND outcomes.management_group_id <> ''
    ORDER BY outcomes.id`, [
    account.user_id, account.trading_account_id, account.ownership_history_id, SYSTEM_MAGIC,
  ])
}

async function loadProfileVersion(versionId) {
  const row = await queryOne(`SELECT versions.id AS version_id, versions.profile_id, versions.version_no,
      versions.config_json, versions.config_hash, profiles.standard_symbol
    FROM position_guard_profile_versions versions
    INNER JOIN position_guard_profiles profiles ON profiles.id = versions.profile_id
    WHERE versions.id = ? LIMIT 1`, [versionId])
  if (!row) return null
  const config = parseJson(row.config_json)
  return config ? { ...row, config } : null
}

async function getOrCreateState(account, outcome, target) {
  let state = await queryOne('SELECT * FROM position_guard_position_states WHERE outcome_id = ?', [outcome.id])
  if (state) return state
  const standardSymbol = stripBrokerSuffix(text(target.symbol)).toUpperCase()
  const profile = await queryOne(`SELECT profiles.current_version_id, versions.config_hash
    FROM position_guard_profiles profiles
    INNER JOIN position_guard_profile_versions versions ON versions.id = profiles.current_version_id
    WHERE profiles.standard_symbol = ? AND profiles.status = 'active'
      AND profiles.current_version_id IS NOT NULL LIMIT 1`, [standardSymbol])
  if (!profile) return null
  const now = beijingNow()
  await queryRun(`INSERT IGNORE INTO position_guard_position_states
    (outcome_id, user_id, trading_account_id, ownership_history_id, ticket,
     original_symbol, standard_symbol, profile_version_id, config_hash,
     state_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [
    outcome.id, account.user_id, account.trading_account_id, account.ownership_history_id,
    text(target.ticket), text(target.symbol), standardSymbol,
    profile.current_version_id, profile.config_hash, now, now,
  ])
  state = await queryOne('SELECT * FROM position_guard_position_states WHERE outcome_id = ?', [outcome.id])
  return state
}

async function getContract(account, route, symbol, bridge) {
  const key = `${route.terminal_instance_id}:${route.connection_epoch}:${upper(symbol)}`
  const cached = contractCache.get(key)
  if (cached && Date.now() - cached.cached_at < CONTRACT_CACHE_MS) return cached.contract
  const result = await bridge(account.user_id, 'symbol_snapshot', {
    symbol, ...routeParams(route),
  }, { noFallback:true, timeoutMs:5_000, expectedGeneration:getBridgeGeneration(account.user_id) })
  if (result?.status !== 'success' || !result.instrument) return null
  const contract = normalizeContract(result)
  if (![contract.digits, contract.point, contract.trade_tick_size,
    contract.volume_min, contract.volume_step].every(value => Number.isFinite(value) && value > 0)) return null
  contractCache.set(key, { contract, cached_at:Date.now() })
  return contract
}

async function refreshPivotSnapshot(account, route, state, symbol, businessDate, profile, rates) {
  const result = await rates(account.user_id, {
    symbol,
    timeframe:'D1',
    count:3,
    prefer_user_source:true,
    platform_trading_account_id:account.trading_account_id,
    platform_route:{
      terminal_instance_id:route.terminal_instance_id,
      account_ref:route.account_ref,
      platform:route.platform,
    },
  })
  const window = selectPositionGuardD1Window(result)
  if (!window.ok) return window
  const pivotDate = positionGuardBusinessDate(window.current_open_utc_msc,
    result.market_meta?.timezone_offset_minutes)
  if (!pivotDate || pivotDate !== businessDate) {
    return { ok:false, code:'position_guard_d1_rollover_not_ready' }
  }
  const snapshot = {
    d1:window.d1,
    standard_symbol:state.standard_symbol,
    broker_symbol:symbol,
    profile_version_id:Number(profile.version_id),
    config_hash:profile.config_hash,
    market_meta:{
      source_id:result.market_meta?.source_id || null,
      platform:result.market_meta?.platform || route.platform || null,
      clock_status:result.market_meta?.clock_status || null,
      timezone_offset_minutes:result.market_meta?.timezone_offset_minutes,
    },
  }
  const now = beijingNow()
  const changed = await queryRun(`UPDATE position_guard_position_states
    SET pivot_business_date = ?, pivot_snapshot_json = ?, pivot_d1_time_utc_ms = ?,
      state_version = state_version + 1, last_error_code = NULL, updated_at = ?
    WHERE id = ? AND state_version = ? AND pending_task_id IS NULL`, [
    businessDate, JSON.stringify(snapshot), window.previous_open_utc_msc,
    now, state.id, state.state_version,
  ])
  if (Number(changed?.changes ?? changed?.affectedRows ?? 0) !== 1) {
    return { ok:false, code:'position_guard_state_changed' }
  }
  return { ok:true, snapshot, state:{ ...state, pivot_business_date:businessDate,
    pivot_snapshot_json:JSON.stringify(snapshot), pivot_d1_time_utc_ms:window.previous_open_utc_msc,
    state_version:Number(state.state_version) + 1, updated_at:now } }
}

async function persistObserve(state, evaluation) {
  const next = evaluation.next_stage_state || {}
  const now = beijingNow()
  const result = await queryRun(`UPDATE position_guard_position_states
    SET pivot_cross_since_utc_ms = ?, pivot_tp_done = ?, first_target_done = ?,
      break_even_done = ?, break_even_pending = ?, pending_break_even_price = ?,
      pending_break_even_trigger = ?, state_version = state_version + 1,
      last_evaluated_at = ?, retry_after = NULL, last_error_code = NULL, updated_at = ?
    WHERE id = ? AND state_version = ? AND pending_task_id IS NULL AND completed_at IS NULL`, [
    next.pivot_cross_since_utc_ms ?? null,
    next.pivot_tp_done ? 1 : 0,
    next.first_target_done ? 1 : 0,
    next.break_even_done ? 1 : 0,
    next.break_even_pending ? 1 : 0,
    next.pending_break_even_price ?? null,
    next.pending_break_even_trigger ?? null,
    now, now, state.id, state.state_version,
  ])
  return Number(result?.changes ?? result?.affectedRows ?? 0) === 1
}

async function persistEvaluationFailure(state, evaluation) {
  const rawCode = evaluation?.error?.code
  const code = typeof rawCode === 'string' && rawCode.trim()
    ? rawCode.trim().slice(0, 96)
    : 'position_guard_evaluation_failed'
  const now = beijingNow()
  const result = await queryRun(`UPDATE position_guard_position_states
    SET last_evaluated_at = ?, last_error_code = ?, updated_at = ?
    WHERE id = ? AND state_version = ? AND pending_task_id IS NULL AND completed_at IS NULL`, [
    now, code, now, state.id, state.state_version,
  ])
  return Number(result?.changes ?? result?.affectedRows ?? 0) === 1
}

function normalizedActionEvidence(action) {
  const normalized = { ...action }
  if (normalized.type === 'move_protection' && normalized.stop_loss == null) {
    normalized.stop_loss = normalized.new_sl ?? normalized.price ?? null
  }
  if (normalized.next_protection && normalized.next_protection.stop_loss == null) {
    normalized.next_protection = {
      ...normalized.next_protection,
      stop_loss:normalized.next_protection.price ?? null,
    }
  }
  return normalized
}

async function createActionTask({ account, route, outcome, target, state, profile, quote,
  contract, pivotSnapshot, evaluation } = {}) {
  const action = normalizedActionEvidence(evaluation.action)
  const evidence = {
    contract_version:1,
    decision_source:'pivot_guard',
    profile:{ version_id:Number(profile.version_id), version_no:Number(profile.version_no),
      config_hash:profile.config_hash },
    route:{ terminal_instance_id:route.terminal_instance_id, connection_epoch:Number(route.connection_epoch),
      account_ref:route.account_ref, platform:route.platform || null },
    position:{ ticket:text(target.ticket), symbol:text(target.symbol), direction:text(target.type).toLowerCase(),
      magic:Number(target.magic), volume:Number(target.volume), price_open:Number(target.price_open),
      sl:Number(target.sl || 0), tp:Number(target.tp || 0) },
    quote,
    contract,
    d1:pivotSnapshot.d1,
    params:profile.config,
    action,
    next_stage_state:evaluation.next_stage_state || null,
  }
  const marketHash = digest({ route:evidence.route, quote, d1:pivotSnapshot.d1, position:evidence.position })
  const taskKey = digest(['pivot_guard', state.id, state.state_version, profile.version_id,
    action.type, action.trigger_code, marketHash])
  const now = beijingNow()
  const created = await withTransaction(async run => {
    const [stateRows] = await run(`SELECT * FROM position_guard_position_states
      WHERE id = ? FOR UPDATE`, [state.id])
    const current = stateRows?.[0]
    if (!current || current.completed_at || current.pending_task_id
      || Number(current.state_version) !== Number(state.state_version)) return null
    const [controlRows] = await run(`SELECT enabled FROM global_position_guard_control WHERE id = 1 FOR UPDATE`)
    const [settingRows] = await run(`SELECT enabled FROM user_position_guard_settings
      WHERE user_id = ? AND trading_account_id = ? FOR UPDATE`, [account.user_id, account.trading_account_id])
    const [ownershipRows] = await run(`SELECT id FROM mt5_account_ownership_history
      WHERE id = ? AND user_id = ? AND trading_account_id = ? AND ended_at IS NULL FOR UPDATE`, [
      account.ownership_history_id, account.user_id, account.trading_account_id,
    ])
    const [outcomeRows] = await run(`SELECT id, status, attribution_status, external_intervention,
        position_id, system_magic FROM signal_outcomes WHERE id = ? FOR UPDATE`, [outcome.id])
    const currentOutcome = outcomeRows?.[0]
    if (Number(controlRows?.[0]?.enabled || 0) !== 1
      || Number(settingRows?.[0]?.enabled || 0) !== 1 || !ownershipRows?.[0]
      || text(currentOutcome?.status).toLowerCase() !== 'open'
      || text(currentOutcome?.attribution_status).toLowerCase() !== 'attributed'
      || Number(currentOutcome?.external_intervention || 0) !== 0
      || text(currentOutcome?.position_id) !== text(target.ticket)
      || Number(currentOutcome?.system_magic || 0) !== SYSTEM_MAGIC) return null
    const [inserted] = await run(`INSERT IGNORE INTO ai_position_management_tasks
      (task_key, task_type, execution_mode, user_id, trading_account_id, ownership_history_id,
       broker_server_key, login_account, bridge_generation, original_symbol, standard_symbol,
       strategy_id, strategy_version, management_group_id, thesis_id, origin_signal_id,
       decision_signal_id, outcome_id, decision_timeframe, closed_bar_time_utc_ms,
       market_snapshot_hash, candidate_action, reversal_candidate, model_evaluation_json,
       evidence_validation_json, confirmation_count, required_confirmations, status,
       state_version, candidate_expires_at, decision_source, position_guard_state_id,
       trigger_code, deterministic_evidence_json, created_at, updated_at)
      VALUES (?, 'position_guard', 'auto_exit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'D1', ?, ?, ?, 0, ?, ?, 1, 1, 'EVIDENCE_CONFIRMED', 1,
        DATE_ADD(NOW(), INTERVAL 1 DAY), 'pivot_guard', ?, ?, ?, ?, ?)`, [
      taskKey, account.user_id, account.trading_account_id, account.ownership_history_id,
      upper(account.broker_server_key || account.broker_server), text(account.login_account),
      getBridgeGeneration(account.user_id), text(target.symbol), state.standard_symbol,
      Number(outcome.strategy_id), Number(outcome.strategy_version || 1), text(outcome.management_group_id),
      text(outcome.thesis_id), outcome.signal_id || null, outcome.signal_id || null, outcome.id,
      Number(state.pivot_d1_time_utc_ms), marketHash, action.type,
      JSON.stringify({ ...evaluation, action }),
      JSON.stringify({ status:'confirmed', source:'deterministic_pivot_guard', confirmation_count:1,
        required_confirmations:1 }),
      state.id, text(action.trigger_code), JSON.stringify(evidence), now, now,
    ])
    const taskId = Number(inserted?.insertId || 0)
    if (!taskId) return null
    const [stateUpdate] = await run(`UPDATE position_guard_position_states
      SET pending_task_id = ?, last_evaluated_at = ?, state_version = state_version + 1,
        retry_after = NULL, last_error_code = NULL, updated_at = ?
      WHERE id = ? AND state_version = ? AND pending_task_id IS NULL`, [
      taskId, now, now, state.id, state.state_version,
    ])
    if (Number(stateUpdate?.affectedRows ?? 0) !== 1) throw new Error('position_guard_state_task_bind_conflict')
    await run(`INSERT INTO ai_position_management_events
      (task_id, from_status, to_status, event_type, summary, details_json, actor_type, created_at)
      VALUES (?, NULL, 'EVIDENCE_CONFIRMED', 'position_guard_action_confirmed',
        'PivotGuard 确定性规则已生成持仓管理动作', ?, 'system', ?)`, [
      taskId, JSON.stringify({ trigger_code:action.trigger_code, action:action.type,
        profile_version_id:Number(profile.version_id), market_snapshot_hash:marketHash }), now,
    ])
    return taskId
  })
  if (created) requestPositionManagementWorkerRun()
  return created
}

async function processAccount(account, dependencies) {
  const { bridge, rates, quoteProvider } = dependencies
  const route = getBridgeDataRoute(account.user_id, account.trading_account_id, { strictAccount:true })
  if (!route || Number(route.connection_epoch) <= 0) {
    return { active:false, interval:OFFLINE_INTERVAL_MS, reason:'bridge_offline', evaluated:0, created:0 }
  }
  const outcomes = await loadEligibleOutcomes(account)
  if (!outcomes.length) return { active:false, interval:IDLE_INTERVAL_MS, reason:'no_eligible_positions', evaluated:0, created:0 }
  const inventory = await bridge(account.user_id, 'system_trade_inventory', routeParams(route), {
    noFallback:true, timeoutMs:5_000, expectedGeneration:getBridgeGeneration(account.user_id),
  })
  if (inventory?.status !== 'success' || !inventory.account || !Array.isArray(inventory.positions)
    || upper(inventory.account.server) !== upper(account.broker_server_key || account.broker_server)
    || text(inventory.account.login) !== text(account.login_account)) {
    return { active:false, interval:OFFLINE_INTERVAL_MS, reason:'inventory_unavailable', evaluated:0, created:0 }
  }
  const targets = outcomes.map(outcome => ({ outcome, target:exactPositionGuardTarget(outcome, inventory) }))
    .filter(item => item.target)
  if (!targets.length) return { active:false, interval:IDLE_INTERVAL_MS, reason:'no_exact_positions', evaluated:0, created:0 }
  const grouped = new Map()
  for (const item of targets) {
    const symbol = text(item.target.symbol)
    if (!grouped.has(symbol)) grouped.set(symbol, [])
    grouped.get(symbol).push(item)
  }
  let evaluated = 0
  let created = 0
  for (const [symbol, items] of grouped) {
    const quoteResult = await quoteProvider({
      userId:account.user_id,
      tradingAccountId:account.trading_account_id,
      terminalInstanceId:route.terminal_instance_id,
      connectionEpoch:route.connection_epoch,
      accountRef:route.account_ref,
      symbol,
    }, { bridge })
    if (!quoteResult?.ok) continue
    const quote = quoteResult.quote
    const businessDate = positionGuardBusinessDate(quote.observed_at_utc_msc, quote.timezone_offset_minutes)
    if (!businessDate) continue
    const contract = await getContract(account, route, symbol, bridge)
    if (!contract) continue
    for (const { outcome, target } of items) {
      let state = await getOrCreateState(account, outcome, target)
      if (!state || state.completed_at || state.pending_task_id
        || Number(state.user_id) !== Number(account.user_id)
        || Number(state.trading_account_id) !== Number(account.trading_account_id)
        || Number(state.ownership_history_id) !== Number(account.ownership_history_id)
        || text(state.ticket) !== text(target.ticket)
        || upper(state.original_symbol) !== upper(target.symbol)) continue
      if (state.retry_after && parseBeijing(state.retry_after)?.getTime() > Date.now()) continue
      const profile = await loadProfileVersion(state.profile_version_id)
      if (!profile || profile.config_hash !== state.config_hash) continue
      let pivotSnapshot = parseJson(state.pivot_snapshot_json)
      if (!pivotSnapshot?.d1 || text(state.pivot_business_date) !== businessDate) {
        const refreshed = await refreshPivotSnapshot(account, route, state, symbol,
          businessDate, profile, rates)
        if (!refreshed.ok) continue
        state = refreshed.state
        pivotSnapshot = refreshed.snapshot
      }
      const position = normalizePosition(outcome, target, quote)
      const evaluation = evaluatePositionGuard({
        d1:pivotSnapshot.d1,
        position,
        quote,
        params:profile.config,
        contract,
        stage_state:state,
        now_ms:Number(quote.observed_at_utc_msc),
      })
      evaluated += 1
      if (!evaluation.ok) {
        await persistEvaluationFailure(state, evaluation)
        continue
      }
      if (evaluation.action?.side_effect !== true || evaluation.action?.type === 'observe') {
        await persistObserve(state, evaluation)
        continue
      }
      const taskId = await createActionTask({ account, route, outcome, target, state,
        profile, quote, contract, pivotSnapshot, evaluation })
      if (taskId) created += 1
    }
  }
  return { active:true, interval:ACTIVE_INTERVAL_MS, reason:null, evaluated, created }
}

export async function runPositionGuardMonitorOnce({
  bridge = mt5Bridge, rates = getPlatformRates, quoteProvider = getPositionGuardQuote, now = Date.now(),
} = {}) {
  if (workerRunning) return { skipped:true, reason:'worker_already_running' }
  workerRunning = true
  runtimeStatus.running = true
  runtimeStatus.last_started_at = beijingNow()
  runtimeStatus.last_error = null
  let activeAccounts = 0
  let evaluated = 0
  let created = 0
  try {
    const control = await getPositionGuardGlobalControl()
    if (!control.enabled) {
      runtimeStatus.last_skip_reason = 'global_control_disabled'
      return { skipped:true, reason:'global_control_disabled', evaluated:0, created:0 }
    }
    const accounts = await listEnabledPositionGuardAccounts()
    runtimeStatus.enabled_accounts = accounts.length
    if (!accounts.length) {
      runtimeStatus.last_skip_reason = 'no_enabled_accounts'
      return { skipped:true, reason:'no_enabled_accounts', evaluated:0, created:0 }
    }
    for (const account of accounts) {
      const key = accountKey(account)
      if (!wakeQueued && Number(accountNextCheck.get(key) || 0) > Number(now)) continue
      try {
        const result = await processAccount(account, { bridge, rates, quoteProvider })
        if (result.active) activeAccounts += 1
        evaluated += result.evaluated
        created += result.created
        accountNextCheck.set(key, Number(now) + result.interval)
      } catch (error) {
        runtimeStatus.last_error = error.message
        accountNextCheck.set(key, Number(now) + OFFLINE_INTERVAL_MS)
        console.error(`[PositionGuardMonitor] account=${key}:`, error.message)
      }
    }
    runtimeStatus.active_accounts = activeAccounts
    runtimeStatus.evaluated_positions += evaluated
    runtimeStatus.created_tasks += created
    runtimeStatus.last_skip_reason = null
    return { skipped:false, enabled:accounts.length, active:activeAccounts, evaluated, created }
  } finally {
    wakeQueued = false
    workerRunning = false
    runtimeStatus.running = false
    runtimeStatus.last_finished_at = beijingNow()
  }
}

function runGuarded() {
  return runPositionGuardMonitorOnce().catch(error => {
    runtimeStatus.last_error = error.message
    console.error('[PositionGuardMonitor]', error.message)
  })
}

export function requestPositionGuardMonitorRun() {
  accountNextCheck.clear()
  wakeQueued = true
  setImmediate(runGuarded)
}

export function startPositionGuardMonitorWorker(intervalMs = ACTIVE_INTERVAL_MS) {
  if (workerTimer) return
  workerTimer = setInterval(runGuarded, Math.max(ACTIVE_INTERVAL_MS, Number(intervalMs) || ACTIVE_INTERVAL_MS))
  workerTimer.unref?.()
  runGuarded()
  console.log('[PositionGuardMonitor] Started with 5-second active-position cadence')
}

export function stopPositionGuardMonitorWorker() {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}

export function getPositionGuardMonitorStatus() {
  return {
    ...runtimeStatus,
    timer_active:Boolean(workerTimer),
    quote_cache:getPositionGuardQuoteCacheMetrics(),
  }
}

export function resetPositionGuardMonitorForTests() {
  stopPositionGuardMonitorWorker()
  workerRunning = false
  wakeQueued = false
  accountNextCheck.clear()
  contractCache.clear()
}
