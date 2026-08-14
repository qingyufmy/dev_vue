import crypto from 'node:crypto'
import { beijingAfter, beijingNow, parseBeijing, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'
import { isSubscriptionScheduleActive } from '../routes/ai/subscription-schedule.js'
import { getBridgeGeneration, isBridgeAlive, isTradeEnabled } from '../bridge-ws.js'

export const ADMIN_STRATEGY_TRADE_SOURCE = 'admin_strategy_dispatch'
export const ADMIN_STRATEGY_TRADE_ENTRY_METHODS = Object.freeze(['market'])
export const ADMIN_STRATEGY_TRADE_MAGIC = 234000
const VALID_DIRECTIONS = new Set(['buy', 'sell'])
const PREVIEWABLE_STATUSES = new Set(['draft', 'previewed', 'confirmed'])
const RETRYABLE_TARGET_STATUSES = new Set(['failed', 'rejected', 'failed_manual_review'])

function fail(code, details = {}) {
  const error = new Error(code)
  error.code = code
  error.reason = code
  error.details = details
  return error
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function normalizeId(value, name) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(`${name}_invalid`)
  return id
}

function normalizePrice(value, name, required = true) {
  if (value === null || value === undefined || value === '') {
    if (required) throw fail(`${name}_required`)
    return null
  }
  const price = Number(value)
  if (!Number.isFinite(price) || price <= 0) throw fail(`${name}_invalid`)
  return price
}

function normalizeVolume(value) {
  if (value === null || value === undefined || value === '') throw fail('volume_required')
  const volume = Number(value)
  if (!Number.isFinite(volume) || volume <= 0) throw fail('volume_invalid')
  // The dispatch ledger stores DECIMAL(20,8). Freeze the same precision in
  // the request/hash/snapshots so MySQL conversion cannot silently alter the
  // value after the preview has been confirmed.
  const normalized = Number(volume.toFixed(8))
  if (!Number.isFinite(normalized) || normalized <= 0) throw fail('volume_invalid')
  return normalized
}

export function normalizeAdminStrategyTradeInput(body = {}, headers = {}) {
  const strategyId = normalizeId(body.strategy_id, 'strategy_id')
  const accountId = normalizeId(body.trading_account_id, 'trading_account_id')
  const symbol = stripBrokerSuffix(String(body.symbol || '').trim()).toUpperCase()
  if (!symbol || symbol.length > 64) throw fail('symbol_invalid')
  const direction = String(body.direction || body.order_type || '').trim().toLowerCase()
  if (!VALID_DIRECTIONS.has(direction)) throw fail('direction_invalid')
  const entryMethod = String(body.entry_method || 'market').trim().toLowerCase()
  if (!ADMIN_STRATEGY_TRADE_ENTRY_METHODS.includes(entryMethod)) throw fail('entry_method_not_supported')
  const volume = normalizeVolume(body.volume)
  const validUntilRaw = body.valid_until_utc_msc ?? body.valid_until
  const validMinutes = Number(body.valid_minutes)
  const validUntil = validUntilRaw == null && Number.isFinite(validMinutes) && validMinutes > 0
    ? Date.now() + validMinutes * 60_000 : Number(validUntilRaw)
  if (!Number.isSafeInteger(validUntil) || validUntil <= Date.now()) throw fail('valid_until_invalid')
  if (validUntil > Date.now() + 7 * 24 * 3600_000) throw fail('valid_until_too_far')
  const reason = String(body.reason ?? '').trim()
  if (reason && (reason.length < 2 || reason.length > 500)) throw fail('reason_invalid')
  const input = {
    strategy_id: strategyId,
    trading_account_id: accountId,
    symbol,
    direction,
    entry_method: entryMethod,
    entry_price: normalizePrice(body.entry_price, 'entry_price', false),
    stop_loss: normalizePrice(body.stop_loss ?? body.stop_loss_price, 'stop_loss', false),
    take_profit_1: normalizePrice(body.take_profit_1 ?? body.take_profit_1_price ?? body.take_profit, 'take_profit_1', false),
    take_profit_2: normalizePrice(body.take_profit_2 ?? body.take_profit_2_price, 'take_profit_2', false),
    take_profit_3: normalizePrice(body.take_profit_3 ?? body.take_profit_3_price, 'take_profit_3', false),
    volume,
    valid_until_utc_msc: validUntil,
    reason,
    idempotency_key: String(body.idempotency_key || body.client_request_id || headers['idempotency-key'] || '').trim() || crypto.randomUUID(),
    preview_hash: String(body.preview_hash || '').trim() || null,
    confirm: body.confirm === true,
  }
  if (input.idempotency_key.length > 191) throw fail('idempotency_key_invalid')
  return input
}

function stableHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function parseSymbols(value) {
  const parsed = parseJson(value, [])
  return Array.isArray(parsed)
    ? [...new Set(parsed.map(item => stripBrokerSuffix(String(item || '').trim()).toUpperCase()).filter(Boolean))]
    : []
}

export function resolveEffectiveSymbolsForDispatch(selectedSymbolsJson, strategySymbolsJson) {
  const strategySymbols = parseSymbols(strategySymbolsJson)
  if (selectedSymbolsJson == null) return strategySymbols
  let selected
  try { selected = JSON.parse(selectedSymbolsJson) } catch { return [] }
  if (!Array.isArray(selected) || selected.length === 0) return []
  const requested = [...new Set(selected.map(item => stripBrokerSuffix(String(item || '').trim()).toUpperCase()).filter(Boolean))]
  return requested.filter(symbol => strategySymbols.includes(symbol))
}

function symbolMatches(symbol, ...symbolLists) {
  const wanted = stripBrokerSuffix(String(symbol || '')).toUpperCase()
  return symbolLists.flatMap(parseSymbols).some(item => stripBrokerSuffix(item) === wanted)
}

function snapshotForTarget(row, input, strategy, targetRole, exclusionReason = null) {
  const schedule = {
    enabled: Number(row.schedule_enabled || 0) === 1,
    timezone: row.schedule_timezone || 'terminal_server',
    weekdays: parseJson(row.schedule_weekdays_json, []),
    windows: parseJson(row.schedule_windows_json, []),
    outside_window_behavior: row.outside_window_behavior || 'pause_all',
    runtime_timezone_offset_minutes: row.runtime_timezone_offset_minutes ?? null,
    runtime_clock_status: row.runtime_clock_status || null,
  }
  const account = {
    id: Number(row.trading_account_id || 0), user_id: Number(row.user_id || 0),
    broker_server: row.broker_server || null, login_account: row.login_account || null,
    nickname: row.account_nickname || null, margin_mode: row.margin_mode || null,
    observe_status: row.observe_status || null, is_deleted: Number(row.account_is_deleted || 0),
  }
  const ownership = {
    id: row.ownership_history_id ? Number(row.ownership_history_id) : null,
    user_id: row.ownership_user_id ? Number(row.ownership_user_id) : null,
    trading_account_id: row.ownership_trading_account_id ? Number(row.ownership_trading_account_id) : null,
    broker_server_key: row.ownership_broker_server_key || null,
    login_account: row.ownership_login_account || null,
  }
  const subscription = targetRole === 'source' ? null : {
    id: row.subscription_id ? Number(row.subscription_id) : null,
    user_id: Number(row.user_id || 0), strategy_id: Number(row.strategy_id || 0),
    execution_enabled: Number(row.execution_enabled || 0), is_deleted: Number(row.subscription_deleted || 0),
    symbols: resolveEffectiveSymbolsForDispatch(row.symbols_json, row.strategy_symbols_json), take_profit_mode: row.take_profit_mode || null,
  }
  const risk = {
    profile_id: row.risk_profile_id ? Number(row.risk_profile_id) : null,
    profile_status: row.risk_profile_status || null,
    profile_config: parseJson(row.risk_profile_config_json, {}),
    halt_status: row.halt_status || null, user_kill_switch: Number(row.user_kill_switch || 0),
  }
  return {
    target_role: targetRole, dispatch_symbol: input.symbol, direction: input.direction,
    // Freeze the administrator's explicit hand size in every target snapshot;
    // subscribers must not recalculate it from a legacy position tier.
    requested_volume: input.volume,
    standard_symbol: input.symbol, take_profit_mode: row.take_profit_mode || null,
    subscription, user: { id: Number(row.user_id || 0), role: row.user_role || null, plan: row.plan || null, plan_expires_at: row.plan_expires_at || null },
    account, broker: { server: row.broker_server || null, login: row.login_account || null },
    ownership, schedule, risk, bridge_generation: row.bridge_generation == null ? null : Number(row.bridge_generation),
    strategy: { id: Number(strategy.id), scope: strategy.scope, owner_user_id: Number(strategy.owner_user_id || 0), version: Number(strategy.version || 1) },
    exclusion_reason: exclusionReason,
  }
}

async function loadPlatformStrategy(strategyId) {
  const strategy = await queryOne(`SELECT * FROM auto_prompt_types
    WHERE id = ? AND scope = 'platform' AND owner_user_id = 0
      AND is_active = 1 AND visibility_status = 'active' AND deleted_at IS NULL`, [strategyId])
  if (!strategy) throw fail('platform_strategy_not_found')
  return strategy
}

async function loadSourceRow(actorUserId, accountId) {
  const row = await queryOne(`SELECT ta.*, u.role AS user_role, u.plan, u.plan_expires_at,
      own.id AS ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key AS ownership_broker_server_key, own.login_account AS ownership_login_account,
      ubs.trade_send_enabled, sched.enable_auto_trade AS scheduler_enable_auto_trade,
      sched.enabled AS scheduler_enabled, NULL AS bridge_generation
    FROM trading_accounts ta JOIN users u ON u.id = ta.user_id
    LEFT JOIN mt5_account_ownership_history own ON own.trading_account_id = ta.id AND own.ended_at IS NULL
    LEFT JOIN user_bridge_settings ubs ON ubs.user_id = ta.user_id
    LEFT JOIN auto_scheduler sched ON sched.user_id = ta.user_id
    WHERE ta.id = ? AND ta.user_id = ? AND ta.is_deleted = 0 LIMIT 1`, [accountId, actorUserId])
  if (!row) throw fail('source_account_not_found')
  return row
}

async function loadSubscriberRows(strategyId) {
  return queryAll(`SELECT ss.*, apt.symbols_json AS strategy_symbols_json,
      u.role AS user_role, u.plan, u.plan_expires_at,
      ta.broker_server, ta.login_account, ta.nickname AS account_nickname,
      ta.margin_mode, ta.observe_status, ta.is_deleted AS account_is_deleted,
      own.id AS ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key AS ownership_broker_server_key, own.login_account AS ownership_login_account,
      rp.status AS risk_profile_status, rp.config_json AS risk_profile_config_json,
      ras.halt_status, ras.user_kill_switch, ubs.trade_send_enabled,
      sched.enable_auto_trade AS scheduler_enable_auto_trade, sched.enabled AS scheduler_enabled,
      mds.timezone_offset_minutes AS runtime_timezone_offset_minutes,
      mds.clock_status AS runtime_clock_status, NULL AS bridge_generation
    FROM strategy_subscriptions ss JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
    JOIN users u ON u.id = ss.user_id
    LEFT JOIN trading_accounts ta ON ta.id = ss.trading_account_id
    LEFT JOIN mt5_account_ownership_history own ON own.trading_account_id = ta.id AND own.ended_at IS NULL
    LEFT JOIN risk_profiles rp ON rp.id = ss.risk_profile_id AND rp.deleted_at IS NULL
    LEFT JOIN risk_account_state ras ON ras.trading_account_id = ss.trading_account_id
    LEFT JOIN user_bridge_settings ubs ON ubs.user_id = ss.user_id
    LEFT JOIN auto_scheduler sched ON sched.user_id = ss.user_id
    LEFT JOIN market_data_sources mds ON mds.id = (
      SELECT MAX(mds2.id) FROM market_data_sources mds2
      WHERE mds2.bridge_user_id = ss.user_id
        AND UPPER(COALESCE(mds2.broker_server, '')) = UPPER(ta.broker_server)
        AND CAST(COALESCE(mds2.account_login, 0) AS CHAR) = CAST(ta.login_account AS CHAR)
    )
    WHERE ss.strategy_id = ? AND ss.is_deleted = 0
    ORDER BY ss.id ASC`, [strategyId])
}

function uniqueSubscriberRows(rows = []) {
  const seen = new Set()
  return rows.filter(row => {
    const key = `${Number(row.id || 0)}:${Number(row.user_id || 0)}:${Number(row.trading_account_id || 0)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildPreviewSummary(source, targets = []) {
  const sourceEligible = source?.valid ? 1 : 0
  const eligibleSubscribers = targets.filter(item => item.valid).length
  const excludedSubscribers = targets.length - eligibleSubscribers
  return {
    target_count: targets.length + 1,
    eligible_target_count: eligibleSubscribers + sourceEligible,
    excluded_target_count: excludedSubscribers + (sourceEligible ? 0 : 1),
    source_valid: Boolean(source?.valid),
  }
}

function sourceEligibility(row, actorUserId) {
  if (Number(row.observe_status ? row.observe_status === 'active' : 0) !== 1) return 'source_account_not_active'
  if (Number(row.ownership_user_id) !== Number(actorUserId)
    || Number(row.ownership_trading_account_id) !== Number(row.id)) return 'source_ownership_unavailable'
  if (Number(row.trade_send_enabled ?? 1) !== 1) return 'source_trade_send_disabled'
  if (!isBridgeAlive(actorUserId)) return 'source_bridge_offline'
  if (!isTradeEnabled(actorUserId)) return 'source_bridge_trade_disabled'
  return null
}

function subscriberEligibility(row, actorUserId, input, strategy) {
  if (Number(row.user_id) === Number(actorUserId)
    && String(row.broker_server || '').toUpperCase() === String(row.source_broker_server || '').toUpperCase()
    && String(row.login_account || '') === String(row.source_login_account || '')) return 'admin_account_excluded'
  if (!resolveEffectiveSymbolsForDispatch(row.symbols_json, row.strategy_symbols_json).includes(input.symbol)) return 'symbol_not_subscribed'
  if (Number(row.execution_enabled || 0) !== 1) return 'execution_disabled'
  if (Number(row.scheduler_enable_auto_trade ?? 1) !== 1) return 'auto_trade_disabled'
  if (Number(row.scheduler_enabled ?? 1) !== 1) return 'scheduler_disabled'
  const expiry = row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : 0
  if (String(row.user_role || '').toLowerCase() !== 'admin'
    && !['pro', 'plus', 'premium', 'enterprise'].includes(String(row.plan || '').toLowerCase())) return 'membership_not_eligible'
  if (expiry && expiry < Date.now()) return 'membership_expired'
  if (row.observe_status !== 'active') return 'account_not_active'
  if (Number(row.ownership_user_id) !== Number(row.user_id)
    || Number(row.ownership_trading_account_id) !== Number(row.trading_account_id)) return 'ownership_unavailable'
  if (!isSubscriptionScheduleActive(row)) return 'outside_schedule'
  if (Number(row.trade_send_enabled ?? 1) !== 1) return 'trade_send_disabled'
  if (!isBridgeAlive(row.user_id)) return 'bridge_offline'
  if (!isTradeEnabled(row.user_id)) return 'bridge_trade_disabled'
  if (String(row.halt_status || '').toLowerCase() === 'halted' || Number(row.user_kill_switch) === 1) return 'risk_halted'
  return null
}

export async function buildAdminStrategyTradePreview(actorUserId, body = {}, headers = {}) {
  const actorId = normalizeId(actorUserId, 'actor_user_id')
  const input = normalizeAdminStrategyTradeInput(body, headers)
  const strategy = await loadPlatformStrategy(input.strategy_id)
  const sourceRow = await loadSourceRow(actorId, input.trading_account_id)
  const sourceReason = sourceEligibility(sourceRow, actorId)
  const source = {
    target_role: 'source', user_id: actorId, trading_account_id: input.trading_account_id,
    valid: !sourceReason, exclusion_reason: sourceReason,
    snapshot: snapshotForTarget({ ...sourceRow, user_id: actorId, bridge_generation: getBridgeGeneration(actorId) ?? sourceRow.bridge_generation }, input, strategy, 'source', sourceReason),
  }
  const subscriberRows = uniqueSubscriberRows(await loadSubscriberRows(input.strategy_id))
  const targets = subscriberRows.map(row => {
    const enriched = { ...row, bridge_generation: getBridgeGeneration(row.user_id) ?? row.bridge_generation, source_broker_server: sourceRow.broker_server, source_login_account: sourceRow.login_account }
    const reason = subscriberEligibility(enriched, actorId, input, strategy)
    return {
      target_role: 'subscriber', subscription_id: Number(row.id), user_id: Number(row.user_id),
      trading_account_id: Number(row.trading_account_id), valid: !reason, exclusion_reason: reason,
      snapshot: snapshotForTarget(enriched, input, strategy, 'subscriber', reason),
    }
  })
  const hashPayload = {
    input: { ...input, preview_hash: null, confirm: undefined }, strategy_id: strategy.id,
    strategy_version: Number(strategy.version || 1), source, targets: targets.map(item => ({
      target_role: item.target_role, subscription_id: item.subscription_id, user_id: item.user_id,
      trading_account_id: item.trading_account_id, valid: item.valid, exclusion_reason: item.exclusion_reason,
      snapshot: item.snapshot,
    })),
  }
  const previewHash = stableHash(hashPayload)
  const exclusions = [...(source.valid ? [] : [source]), ...targets.filter(item => !item.valid)]
  return {
    enabled: true, supported_entry_methods: [...ADMIN_STRATEGY_TRADE_ENTRY_METHODS], preview_hash: previewHash,
    request: { ...input, preview_hash: previewHash },
    strategy: { id: Number(strategy.id), title: strategy.title, scope: strategy.scope, owner_user_id: Number(strategy.owner_user_id || 0), version: Number(strategy.version || 1), symbols: parseSymbols(strategy.symbols_json) },
    source, targets, exclusions,
    summary: buildPreviewSummary(source, targets),
  }
}

function json(value) { return JSON.stringify(value ?? {}) }

async function insertDispatchTx(run, actorId, input, preview) {
  const now = beijingNow()
  const strategySnapshot = { ...preview.strategy, request: preview.request }
  const [dispatchResult] = await run(`INSERT INTO admin_strategy_trade_dispatches
    (idempotency_key, actor_user_id, strategy_id, frozen_strategy_version, strategy_snapshot_json,
     symbol, direction, entry_method, entry_price, stop_loss, take_profit_1, take_profit_2, take_profit_3,
     requested_volume, position_size_tier, valid_until_utc_msc, reason, preview_hash, status, target_count,
     eligible_target_count, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`, [
    input.idempotency_key, actorId, input.strategy_id, Number(preview.strategy.version || 1), json(strategySnapshot),
    input.symbol, input.direction, input.entry_method, input.entry_price, input.stop_loss, input.take_profit_1,
    input.take_profit_2, input.take_profit_3, input.volume, input.valid_until_utc_msc, input.reason,
    preview.preview_hash, preview.summary.target_count, preview.summary.eligible_target_count, now, now,
  ])
  const dispatchId = Number(dispatchResult.insertId)
  const decision = json({ source: ADMIN_STRATEGY_TRADE_SOURCE, dispatch_id: dispatchId, no_inference_snapshot: true,
    execution_validation: { status: 'eligible', eligible: true, reason_codes: [] } })
  const [signalResult] = await run(`INSERT INTO ai_signals
    (user_id, config_id, prompt_type_id, session_id, source, symbol, timeframe, signal_type, confidence,
     recommended_volume, analysis, reasoning,
     stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, market_data_json,
     token_count, ai_model, ttl_seconds, is_executed, created_at, created_at_utc_msc, entry_method, decision_json)
    VALUES (?, 0, ?, 'admin_strategy_dispatch', ?, ?, 'M15', ?, 1, ?, ?, ?, ?, ?, ?, ?, '{}', 0, 'admin_strategy_dispatch', 0, 0, ?, ?, 'market', ?)`, [
    actorId, input.strategy_id, ADMIN_STRATEGY_TRADE_SOURCE, input.symbol, input.direction,
    input.volume, `Admin strategy dispatch ${dispatchId}`, input.reason, input.stop_loss, input.take_profit_1,
    input.take_profit_2, input.take_profit_3, now, Date.now(), decision,
  ])
  const signalId = Number(signalResult.insertId)
  await run('UPDATE admin_strategy_trade_dispatches SET signal_id = ?, source_target_id = NULL, updated_at = ? WHERE id = ?', [signalId, now, dispatchId])
  const source = preview.source
  const sourceSnapshot = source.snapshot
  const [sourceResult] = await run(`INSERT INTO admin_strategy_trade_targets
    (dispatch_id, signal_id, target_role, user_id, subscription_id, trading_account_id, ownership_history_id,
     broker_server_key, login_account, bridge_generation, standard_symbol, take_profit_mode,
     schedule_snapshot_json, risk_snapshot_json, ownership_snapshot_json, account_snapshot_json,
     subscription_snapshot_json, target_snapshot_json, status, exclusion_reason, created_at, updated_at)
    VALUES (?, ?, 'source', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`, [
    dispatchId, signalId, actorId, input.trading_account_id, sourceSnapshot.ownership.id,
    sourceSnapshot.broker.server, sourceSnapshot.broker.login, sourceSnapshot.bridge_generation,
    input.symbol, sourceSnapshot.take_profit_mode, json(sourceSnapshot.schedule), json(sourceSnapshot.risk),
    json(sourceSnapshot.ownership), json(sourceSnapshot.account), json(sourceSnapshot), source.valid ? 'pending' : 'rejected',
    source.exclusion_reason, now, now,
  ])
  const sourceTargetId = Number(sourceResult.insertId)
  for (const target of preview.targets) {
    const s = target.snapshot
    await run(`INSERT INTO admin_strategy_trade_targets
      (dispatch_id, signal_id, target_role, user_id, subscription_id, trading_account_id, risk_profile_id,
       ownership_history_id, broker_server_key, login_account, bridge_generation, standard_symbol, take_profit_mode,
       schedule_snapshot_json, risk_snapshot_json, ownership_snapshot_json, account_snapshot_json,
       subscription_snapshot_json, target_snapshot_json, status, exclusion_reason, created_at, updated_at)
      VALUES (?, ?, 'subscriber', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      dispatchId, signalId, target.user_id, target.subscription_id, target.trading_account_id,
      s.risk.profile_id, s.ownership.id, s.broker.server, s.broker.login, s.bridge_generation,
      input.symbol, s.take_profit_mode, json(s.schedule), json(s.risk), json(s.ownership), json(s.account),
      json(s.subscription), json(s), target.valid ? 'pending' : 'skipped', target.exclusion_reason, now, now,
    ])
  }
  await run(`UPDATE admin_strategy_trade_dispatches SET source_target_id = ?, updated_at = ? WHERE id = ?`, [sourceTargetId, now, dispatchId])
  return { dispatchId, signalId }
}

export async function createAdminStrategyTradeDispatch(actorUserId, body = {}, headers = {}) {
  const actorId = normalizeId(actorUserId, 'actor_user_id')
  const preview = await buildAdminStrategyTradePreview(actorId, body, headers)
  if (body.preview_hash && body.preview_hash !== preview.preview_hash) throw fail('preview_hash_mismatch')
  if (body.confirm !== true) throw fail('confirmation_required', { preview_hash: preview.preview_hash })
  if (!preview.source.valid) throw fail('source_target_not_eligible', { reason: preview.source.exclusion_reason })
  const existing = await queryOne('SELECT id, actor_user_id, preview_hash FROM admin_strategy_trade_dispatches WHERE idempotency_key = ? LIMIT 1', [preview.request.idempotency_key])
  if (existing) {
    if (Number(existing.actor_user_id) !== actorId) throw fail('idempotency_key_conflict')
    return getAdminStrategyTradeDispatch(existing.id, actorId)
  }
  const created = await withTransaction(run => insertDispatchTx(run, actorId, preview.request, preview))
  return getAdminStrategyTradeDispatch(created.dispatchId, actorId)
}

function decodeTarget(row) {
  return { ...row, target_snapshot: parseJson(row.target_snapshot_json), schedule_snapshot: parseJson(row.schedule_snapshot_json), risk_snapshot: parseJson(row.risk_snapshot_json), ownership_snapshot: parseJson(row.ownership_snapshot_json), account_snapshot: parseJson(row.account_snapshot_json), subscription_snapshot: parseJson(row.subscription_snapshot_json), execution_result: parseJson(row.execution_result_json, null) }
}

export async function getAdminStrategyTradeDispatch(dispatchId, actorUserId = null) {
  const id = normalizeId(dispatchId, 'dispatch_id')
  const dispatch = await queryOne(`SELECT d.*, apt.title AS strategy_title, apt.scope AS strategy_scope,
      s.source AS signal_source, s.created_at AS signal_created_at
    FROM admin_strategy_trade_dispatches d LEFT JOIN auto_prompt_types apt ON apt.id = d.strategy_id
      LEFT JOIN ai_signals s ON s.id = d.signal_id WHERE d.id = ?`, [id])
  if (!dispatch || (actorUserId != null && Number(dispatch.actor_user_id) !== normalizeId(actorUserId, 'actor_user_id'))) return null
  const targets = await queryAll('SELECT * FROM admin_strategy_trade_targets WHERE dispatch_id = ? ORDER BY target_role = \'source\' DESC, id ASC', [id])
  return { ...dispatch, strategy_snapshot: parseJson(dispatch.strategy_snapshot_json), targets: targets.map(decodeTarget), summary: { target_count: targets.length, succeeded: targets.filter(t => t.status === 'succeeded').length, rejected: targets.filter(t => t.status === 'rejected').length, skipped: targets.filter(t => t.status === 'skipped').length, failed: targets.filter(t => ['failed', 'failed_manual_review'].includes(t.status)).length, uncertain: targets.filter(t => t.status === 'uncertain').length } }
}

export async function cancelAdminStrategyTradeDispatch(actorUserId, dispatchId) {
  const actorId = normalizeId(actorUserId, 'actor_user_id'); const id = normalizeId(dispatchId, 'dispatch_id'); const now = beijingNow()
  await withTransaction(async run => {
    const [rows] = await run('SELECT * FROM admin_strategy_trade_dispatches WHERE id = ? AND actor_user_id = ? FOR UPDATE', [id, actorId])
    const dispatch = rows?.[0]
    if (!dispatch) throw fail('dispatch_not_found')
    if (!PREVIEWABLE_STATUSES.has(dispatch.status)) throw fail('dispatch_not_cancellable')
    await run("UPDATE admin_strategy_trade_dispatches SET status = 'cancelled_before_send', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, id])
    await run("UPDATE admin_strategy_trade_targets SET status = 'skipped', error_code = 'dispatch_cancelled', completed_at = ?, updated_at = ? WHERE dispatch_id = ? AND status IN ('pending','validating')", [now, now, id])
  })
  return getAdminStrategyTradeDispatch(id, actorId)
}

export async function retryAdminStrategyTradeDispatch(actorUserId, dispatchId) {
  const actorId = normalizeId(actorUserId, 'actor_user_id'); const id = normalizeId(dispatchId, 'dispatch_id'); const now = beijingNow()
  await withTransaction(async run => {
    const [rows] = await run('SELECT * FROM admin_strategy_trade_dispatches WHERE id = ? AND actor_user_id = ? FOR UPDATE', [id, actorId])
    const dispatch = rows?.[0]
    if (!dispatch) throw fail('dispatch_not_found')
    if (dispatch.status === 'cancelled_before_send' || dispatch.status === 'expired') throw fail('dispatch_not_retryable')
    const [uncertain] = await run("SELECT id FROM admin_strategy_trade_targets WHERE dispatch_id = ? AND status IN ('uncertain','reconciling') LIMIT 1", [id])
    if (uncertain?.length) throw fail('uncertain_requires_reconciliation')
    const [retryable] = await run(`SELECT id FROM admin_strategy_trade_targets WHERE dispatch_id = ?
      AND (status IN ('failed','rejected','failed_manual_review') OR (target_role = 'source' AND status = 'skipped')) FOR UPDATE`, [id])
    if (!retryable?.length) throw fail('no_failed_targets')
    await run("UPDATE admin_strategy_trade_dispatches SET status = 'confirmed', completed_at = NULL, updated_at = ? WHERE id = ?", [now, id])
    await run("UPDATE admin_strategy_trade_targets SET status = 'pending', error_code = NULL, completed_at = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE dispatch_id = ? AND (status IN ('failed','rejected','failed_manual_review') OR (target_role = 'source' AND status = 'skipped'))", [now, id])
  })
  return getAdminStrategyTradeDispatch(id, actorId)
}

export async function claimAdminStrategyTradeDispatch(dispatchId, leaseToken, leaseMs = 120_000) {
  const id = normalizeId(dispatchId, 'dispatch_id'); const token = String(leaseToken || crypto.randomUUID()); const now = beijingNow()
  const until = beijingAfter(leaseMs)
  const result = await queryRun(`UPDATE admin_strategy_trade_dispatches SET status = 'delivering', confirmed_at = COALESCE(confirmed_at, ?), lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('confirmed','delivering') AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_token = ?)`, [now, token, until, now, id, now, token])
  return result.changes ? { token, leaseExpiresAt: until } : null
}

export async function assertAdminStrategyTargetSendFence({ dispatchId, targetId, targetRole, sourceRequired = false, leaseToken = null } = {}) {
  const id = normalizeId(dispatchId, 'dispatch_id'); const tid = normalizeId(targetId, 'target_id')
  const rows = await queryAll(`SELECT d.status AS dispatch_status, d.valid_until_utc_msc, d.signal_id,
      t.status AS target_status, t.target_role, t.lease_token, t.lease_expires_at,
      source.status AS source_status
    FROM admin_strategy_trade_dispatches d JOIN admin_strategy_trade_targets t ON t.dispatch_id = d.id
      LEFT JOIN admin_strategy_trade_targets source ON source.id = d.source_target_id
    WHERE d.id = ? AND t.id = ? LIMIT 1`, [id, tid])
  const row = rows[0]
  if (!row || row.target_role !== targetRole) throw fail('admin_strategy_target_not_found')
  if (!['delivering'].includes(row.dispatch_status) || Number(row.valid_until_utc_msc) <= Date.now()) throw fail('admin_strategy_dispatch_send_fence_failed')
  if (!['validating', 'executing'].includes(row.target_status)) throw fail('admin_strategy_target_send_fence_failed')
  if (leaseToken && String(row.lease_token || '') !== String(leaseToken)) throw fail('admin_strategy_target_lease_lost')
  const leaseExpiresAt = parseBeijing(row.lease_expires_at)
  if (row.lease_expires_at && (!leaseExpiresAt || leaseExpiresAt.getTime() <= Date.now())) throw fail('admin_strategy_target_lease_expired')
  if (sourceRequired && row.source_status !== 'succeeded') throw fail('admin_strategy_source_not_confirmed')
  return row
}

export const __adminStrategyTradeTest = {
  normalizeAdminStrategyTradeInput,
  stableHash,
  symbolMatches,
  sourceEligibility,
  subscriberEligibility,
  uniqueSubscriberRows,
  buildPreviewSummary,
  resolveEffectiveSymbolsForDispatch,
}
