import crypto from 'node:crypto'
import * as db from '../db.js'
import * as bridgeWs from '../bridge-ws.js'
import * as marketData from '../routes/ai/market-data.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'

export const ADMIN_SYSTEM_POSITION_SOURCE = 'admin_strategy_dispatch'
export const PLATFORM_SHARED_POSITION_SOURCE = 'auto_shared'
export const ADMIN_SYSTEM_POSITION_MAGIC = 234000

const OPEN_OUTCOME_STATUSES = ['open', 'closing']
const ACTIVE_TARGET_STATUSES = ['pending', 'validating', 'executing', 'delivering', 'succeeded', 'uncertain', 'reconciling']
const CLOSEABLE_TARGET_STATUSES = ['succeeded', 'uncertain', 'reconciling', 'delivering']
const ACTIVE_DISPATCH_STATUSES = ['confirmed', 'delivering', 'succeeded', 'partial']

function optionalModuleFunction(module, name) {
  try { return typeof module[name] === 'function' ? module[name] : null } catch { return null }
}

function text(value) { return String(value ?? '').trim() }

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function fail(code, details = {}) {
  const error = new Error(code)
  error.code = code
  error.reason = code
  error.details = details
  return error
}

function direction(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw.startsWith('buy') || raw === '0' || raw === 'long') return 'buy'
  if (raw.startsWith('sell') || raw === '1' || raw === 'short') return 'sell'
  return raw
}

function symbol(value) {
  return stripBrokerSuffix(text(value)).toUpperCase()
}

function ticket(value) {
  return text(value)
}

function sameNumber(left, right, tolerance = 1e-8) {
  const a = Number(left); const b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance
}

function inventoryTicket(position) {
  return ticket(position?.ticket ?? position?.position_id ?? position?.order)
}

export function inventoryExpectedState(position = {}) {
  return {
    ticket: inventoryTicket(position),
    symbol: text(position.symbol),
    direction: direction(position.side ?? position.type ?? position.direction),
    magic: Number(position.magic || 0),
    volume: Number(position.volume || 0),
  }
}

export function inventoryTargetMatches(position, target, { strictVolume = true } = {}) {
  if (!position || !target) return false
  const expectedDirection = direction(target.direction)
  const actualDirection = direction(position.side ?? position.type ?? position.direction)
  return inventoryTicket(position) === ticket(target.ticket)
    && Number(position.magic) === ADMIN_SYSTEM_POSITION_MAGIC
    && Number(target.magic || ADMIN_SYSTEM_POSITION_MAGIC) === ADMIN_SYSTEM_POSITION_MAGIC
    && symbol(position.symbol) === symbol(target.symbol)
    && actualDirection === expectedDirection
    && (!strictVolume || sameNumber(position.volume, target.volume))
}

function targetSnapshot(row) {
  const snapshot = parseJson(row.target_snapshot_json, {})
  return snapshot && typeof snapshot === 'object' ? snapshot : {}
}

function outcomeSnapshot(row) {
  return {
    id: row.outcome_id ? Number(row.outcome_id) : null,
    signal_id: row.outcome_signal_id ? Number(row.outcome_signal_id) : Number(row.signal_id) || null,
    status: row.outcome_status || null,
    position_id: row.outcome_position_id || null,
    entry_order_ticket: row.outcome_entry_order_ticket || null,
    system_magic: row.outcome_system_magic == null ? ADMIN_SYSTEM_POSITION_MAGIC : Number(row.outcome_system_magic),
    trading_account_id: row.outcome_trading_account_id ? Number(row.outcome_trading_account_id) : null,
    symbol: row.outcome_symbol || null,
    direction: row.outcome_direction || null,
    volume: row.outcome_volume == null ? null : Number(row.outcome_volume),
  }
}

function identityFields(row = {}, { userSnapshot = {}, accountSnapshot = {}, fallbackUserId = null } = {}) {
  const nickname = text(row.nickname || row.user_nickname || userSnapshot.nickname)
  const accountName = text(row.account_name || row.account_nickname || accountSnapshot.nickname)
  const email = text(row.email || row.user_email || userSnapshot.email)
  const userId = Number(row.user_id || fallbackUserId || 0)
  return {
    nickname:nickname || null,
    account_name:accountName || null,
    email:email || null,
    user_label:text(row.user_label) || nickname || accountName || email || (userId > 0 ? `用户 ${userId}` : '未知用户'),
  }
}

function bridgeConnected(row = {}, snapshot = {}) {
  const isAlive = optionalModuleFunction(bridgeWs, 'isBridgeAlive')
  if (isAlive && Number(row.user_id || 0) > 0) return Boolean(isAlive(Number(row.user_id)))
  if (row.bridge_connected != null) return Boolean(row.bridge_connected)
  return snapshot.bridge_connected == null ? null : Boolean(snapshot.bridge_connected)
}

function displayFields(target, { inclusionStatus = null, reasonCode = null } = {}) {
  const code = reasonCode || target?.reason_code || target?.reason || target?.exclusion_reason || null
  return {
    ...identityFields(target, {
      userSnapshot:target?.user_snapshot,
      accountSnapshot:target?.account_snapshot,
      fallbackUserId:target?.user_id,
    }),
    bridge_connected:target?.bridge_connected == null ? null : Boolean(target.bridge_connected),
    inclusion_status:inclusionStatus || (target?.is_source ? 'source_only' : 'included'),
    reason_code:code,
    ...(code ? { reason:code } : {}),
  }
}

function exclusionTarget(target, reason, extra = {}) {
  return {
    ...target,
    ...displayFields(target, { inclusionStatus:'excluded', reasonCode:reason }),
    eligible:false,
    reason,
    reason_code:reason,
    ...extra,
  }
}

function decodeTarget(row, { sourceSignalId = null } = {}) {
  const snapshot = targetSnapshot(row)
  const accountSnapshot = parseJson(row.account_snapshot_json, snapshot.account || {})
  const ownershipSnapshot = parseJson(row.ownership_snapshot_json, snapshot.ownership || {})
  const userSnapshot = parseJson(row.user_snapshot_json, snapshot.user || {})
  const outcome = outcomeSnapshot(row)
  const resolvedTicket = ticket(row.trade_ticket) || ticket(outcome.position_id || outcome.entry_order_ticket)
  const resolvedSymbol = text(row.standard_symbol) || text(snapshot.standard_symbol || snapshot.dispatch_symbol || outcome.symbol)
  const resolvedDirection = direction(row.direction || snapshot.direction || outcome.direction)
  const resolvedVolume = Number(row.volume ?? snapshot.volume ?? outcome.volume ?? 0)
  const targetRole = text(row.target_role).toLowerCase() || 'subscriber'
  const signalId = Number(row.signal_id || sourceSignalId || outcome.signal_id || 0)
  const identity = identityFields(row, { userSnapshot, accountSnapshot, fallbackUserId:row.user_id })
  const reasonCode = row.exclusion_reason || null
  return {
    id: Number(row.id || row.admin_target_id || 0),
    target_role: targetRole,
    is_source: targetRole === 'source',
    user_id: Number(row.user_id || 0),
    trading_account_id: Number(row.trading_account_id || 0),
    ownership_history_id: row.ownership_history_id ? Number(row.ownership_history_id) : null,
    outcome_id: row.outcome_id ? Number(row.outcome_id) : null,
    signal_id: signalId,
    broker_server_key: text(row.broker_server_key || row.account_broker_server || snapshot.broker?.server || accountSnapshot.broker_server),
    login_account: text(row.login_account || row.account_login_account || snapshot.broker?.login || accountSnapshot.login_account),
    ticket: resolvedTicket,
    symbol: resolvedSymbol,
    direction: resolvedDirection,
    volume: Number.isFinite(resolvedVolume) ? resolvedVolume : 0,
    magic: Number(row.magic || snapshot.magic || outcome.system_magic || ADMIN_SYSTEM_POSITION_MAGIC),
    bridge_generation: row.bridge_generation == null ? (snapshot.bridge_generation == null ? null : Number(snapshot.bridge_generation)) : Number(row.bridge_generation),
    status: text(row.status),
    dispatch_status: text(row.dispatch_status),
    dispatch_id: Number(row.dispatch_id || 0) || null,
    actor_user_id: Number(row.actor_user_id || 0) || null,
    target_snapshot: snapshot,
    user_snapshot: userSnapshot,
    account_snapshot: accountSnapshot,
    ownership_snapshot: ownershipSnapshot,
    outcome_snapshot: outcome,
    subscription_id: row.subscription_id ? Number(row.subscription_id) : null,
    exclusion_reason: reasonCode,
    ...identity,
    bridge_connected:bridgeConnected(row, snapshot),
    inclusion_status:targetRole === 'source' ? 'source_only' : reasonCode ? 'excluded' : 'included',
    reason_code:reasonCode,
    ...(reasonCode ? { reason:reasonCode } : {}),
  }
}

async function dbAll(sql, params) {
  const fn = optionalModuleFunction(db, 'queryAll')
  if (!fn) throw fail('admin_dispatch_attribution_query_unavailable')
  return fn(sql, params)
}

async function dbOne(sql, params) {
  const fn = optionalModuleFunction(db, 'queryOne')
  if (!fn) throw fail('admin_dispatch_attribution_query_unavailable')
  return fn(sql, params)
}

async function loadCurrentAccount(userId, account) {
  if (!account) return null
  return dbOne(`SELECT ta.id AS trading_account_id, ta.user_id, ta.broker_server,
      ta.login_account, ta.margin_mode, ta.is_deleted,
      own.id AS ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key, own.login_account AS ownership_login_account
    FROM trading_accounts ta
    LEFT JOIN mt5_account_ownership_history own
      ON own.trading_account_id = ta.id AND own.user_id = ta.user_id AND own.ended_at IS NULL
    WHERE ta.user_id = ? AND ta.is_deleted = 0
      AND UPPER(ta.broker_server) = UPPER(?) AND CAST(ta.login_account AS CHAR) = CAST(? AS CHAR)
    ORDER BY own.started_at DESC, own.id DESC LIMIT 1`, [Number(userId), text(account.server), text(account.login)])
}

async function readInventory(userId, { bridge = null, expectedGeneration = null } = {}) {
  const bridgeFn = bridge || optionalModuleFunction(marketData, 'mt5Bridge')
  if (typeof bridgeFn !== 'function') throw fail('admin_dispatch_inventory_unavailable')
  const result = await bridgeFn(Number(userId), 'system_trade_inventory', {}, {
    noFallback: true, timeoutMs: 10_000,
    ...(expectedGeneration == null ? {} : { expectedGeneration }),
  })
  if (result?.status !== 'success' || !result.account || !Array.isArray(result.positions)) {
    throw fail('admin_dispatch_inventory_unavailable', { response: result || null })
  }
  return result
}

async function loadSourceCandidates(userId, tradingAccountId, sourceTicket) {
  const outcomeRows = await dbAll(`SELECT outcomes.*, outcomes.id AS outcome_id,
      outcomes.signal_id AS outcome_signal_id,
      outcomes.position_id AS outcome_position_id,
      outcomes.entry_order_ticket AS outcome_entry_order_ticket,
      outcomes.status AS outcome_status,
      outcomes.system_magic AS outcome_system_magic,
      outcomes.trading_account_id AS outcome_trading_account_id,
      outcomes.symbol AS outcome_symbol,
      outcomes.entry_direction AS outcome_direction,
      outcomes.expected_volume AS outcome_volume,
      s.id AS root_signal_id, s.source AS signal_source, s.prompt_type_id AS signal_strategy_id,
      strategy.scope AS strategy_scope,
      observer_source.id AS observer_source_id,
      observer_source.bridge_user_id AS observer_source_user_id,
      observer_source.strategy_id AS observer_strategy_id,
      t.id AS admin_target_id, t.target_role, t.status AS target_status,
      t.trade_ticket, t.target_snapshot_json, t.account_snapshot_json,
      t.ownership_snapshot_json, t.bridge_generation, t.broker_server_key,
      t.login_account, t.standard_symbol, t.dispatch_id,
      identity_user.email AS user_email, identity_user.nickname AS user_nickname,
      identity_account.nickname AS account_name,
      d.actor_user_id, d.status AS dispatch_status
    FROM signal_outcomes outcomes
    JOIN ai_signals s ON s.id = outcomes.signal_id AND s.source IN (?, ?)
    LEFT JOIN auto_prompt_types strategy ON strategy.id = s.prompt_type_id AND strategy.deleted_at IS NULL
    LEFT JOIN ai_observer_sources observer_source
      ON observer_source.bridge_user_id = outcomes.user_id
      AND observer_source.strategy_id = s.prompt_type_id
      AND observer_source.status = 'active'
    LEFT JOIN users identity_user ON identity_user.id = outcomes.user_id
    LEFT JOIN trading_accounts identity_account
      ON identity_account.id = outcomes.trading_account_id
      AND identity_account.user_id = outcomes.user_id
      AND identity_account.is_deleted = 0
    LEFT JOIN admin_strategy_trade_targets t
      ON t.signal_id = outcomes.signal_id AND t.target_role = 'source'
      AND t.user_id = outcomes.user_id AND t.trading_account_id = outcomes.trading_account_id
      AND (t.trade_ticket = outcomes.position_id OR t.trade_ticket = outcomes.entry_order_ticket OR t.trade_ticket IS NULL)
    LEFT JOIN admin_strategy_trade_dispatches d ON d.id = t.dispatch_id
    WHERE outcomes.user_id = ? AND outcomes.trading_account_id = ?
      AND (outcomes.position_id = ? OR outcomes.entry_order_ticket = ?)
      AND outcomes.status IN (?, ?) AND COALESCE(outcomes.system_magic, ?) = ?
    ORDER BY outcomes.id`, [ADMIN_SYSTEM_POSITION_SOURCE, PLATFORM_SHARED_POSITION_SOURCE,
    Number(userId), Number(tradingAccountId), ticket(sourceTicket), ticket(sourceTicket),
    ...OPEN_OUTCOME_STATUSES, ADMIN_SYSTEM_POSITION_MAGIC, ADMIN_SYSTEM_POSITION_MAGIC])
  const candidates = outcomeRows.filter(row => {
    const source = text(row.signal_source)
    if (source === ADMIN_SYSTEM_POSITION_SOURCE) return true
    return source === PLATFORM_SHARED_POSITION_SOURCE
      && text(row.strategy_scope).toLowerCase() === 'platform'
      && Number(row.observer_source_id) > 0
      && Number(row.observer_source_user_id) === Number(userId)
      && Number(row.observer_strategy_id) === Number(row.signal_strategy_id)
  })
  if (candidates.length) return candidates

  // A successful Bridge order can precede signal_outcomes attribution by a
  // short reconciliation window.  The frozen admin target is still a valid
  // source root, but only when the signal itself is the explicit admin source.
  return dbAll(`SELECT t.*, d.actor_user_id, d.status AS dispatch_status,
      s.id AS root_signal_id, s.source AS signal_source
    FROM admin_strategy_trade_targets t
    JOIN admin_strategy_trade_dispatches d ON d.id = t.dispatch_id
    JOIN ai_signals s ON s.id = t.signal_id AND s.source = ?
    WHERE t.target_role = 'source' AND t.user_id = ? AND t.trading_account_id = ?
      AND t.trade_ticket = ? AND t.status IN (?, ?, ?, ?, ?, ?)
    ORDER BY t.id`, [ADMIN_SYSTEM_POSITION_SOURCE, Number(userId), Number(tradingAccountId), ticket(sourceTicket), ...CLOSEABLE_TARGET_STATUSES, 'pending', 'executing'])
}

async function loadDispatchTargets(signalId) {
  return dbAll(`SELECT t.*, d.actor_user_id, d.status AS dispatch_status,
      s.id AS root_signal_id, s.source AS signal_source,
      so.id AS outcome_id, so.signal_id AS outcome_signal_id,
      so.status AS outcome_status, so.position_id AS outcome_position_id,
      so.entry_order_ticket AS outcome_entry_order_ticket,
      so.system_magic AS outcome_system_magic, so.trading_account_id AS outcome_trading_account_id,
      so.symbol AS outcome_symbol, so.entry_direction AS outcome_direction,
      so.expected_volume AS outcome_volume,
      ta.broker_server AS account_broker_server, ta.login_account AS account_login_account,
      ta.nickname AS account_name,
      identity_user.email AS user_email, identity_user.nickname AS user_nickname,
      own.id AS current_ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key AS current_broker_server_key,
      own.login_account AS current_login_account
    FROM admin_strategy_trade_targets t
    JOIN admin_strategy_trade_dispatches d ON d.id = t.dispatch_id
    JOIN ai_signals s ON s.id = t.signal_id AND s.source = ?
    LEFT JOIN signal_outcomes so
      ON so.signal_id = t.signal_id AND so.user_id = t.user_id
      AND so.trading_account_id = t.trading_account_id AND so.status IN (?, ?)
      AND (so.position_id = t.trade_ticket OR so.entry_order_ticket = t.trade_ticket)
    LEFT JOIN trading_accounts ta ON ta.id = t.trading_account_id
      AND ta.user_id = t.user_id AND ta.is_deleted = 0
    LEFT JOIN users identity_user ON identity_user.id = t.user_id
    LEFT JOIN mt5_account_ownership_history own
      ON own.trading_account_id = t.trading_account_id AND own.user_id = t.user_id
      AND own.ended_at IS NULL
    WHERE t.signal_id = ? AND t.status IN (?, ?, ?, ?)
      AND d.status IN (?, ?, ?, ?)
    ORDER BY CASE WHEN t.target_role = 'subscriber' THEN 0 ELSE 1 END, t.id`, [ADMIN_SYSTEM_POSITION_SOURCE, ...OPEN_OUTCOME_STATUSES, Number(signalId), ...CLOSEABLE_TARGET_STATUSES, ...ACTIVE_DISPATCH_STATUSES])
}

async function loadPlatformDeliveryTargets(signalId, sourceUserId) {
  return dbAll(`SELECT d.id, d.id AS delivery_id, d.signal_id,
      'subscriber' AS target_role, d.execution_status AS status,
      s.id AS root_signal_id, s.source AS signal_source,
      so.id AS outcome_id, so.signal_id AS outcome_signal_id,
      so.status AS outcome_status, so.position_id AS outcome_position_id,
      so.entry_order_ticket AS outcome_entry_order_ticket,
      so.system_magic AS outcome_system_magic,
      so.trading_account_id AS outcome_trading_account_id,
      so.symbol AS outcome_symbol, so.entry_direction AS outcome_direction,
      so.expected_volume AS outcome_volume,
      so.user_id, so.trading_account_id, so.ownership_history_id,
      so.broker_server_key, so.login_account,
      so.position_id AS trade_ticket, so.symbol AS standard_symbol,
      so.entry_direction AS direction, so.expected_volume AS volume,
      ta.broker_server AS account_broker_server, ta.login_account AS account_login_account,
      ta.nickname AS account_name,
      identity_user.email AS user_email, identity_user.nickname AS user_nickname,
      own.id AS current_ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key AS current_broker_server_key,
      own.login_account AS current_login_account
    FROM auto_signal_deliveries d
    JOIN ai_signals s ON s.id = d.signal_id AND s.source = ?
    JOIN order_intents oi ON oi.id = d.order_intent_id
      AND oi.user_id = d.user_id AND oi.status IN ('succeeded', 'success')
    JOIN signal_outcomes so ON so.delivery_id = d.id
      AND so.order_intent_id = d.order_intent_id
      AND so.user_id = d.user_id AND so.status IN (?, ?)
    LEFT JOIN trading_accounts ta ON ta.id = so.trading_account_id
      AND ta.user_id = so.user_id AND ta.is_deleted = 0
    LEFT JOIN users identity_user ON identity_user.id = so.user_id
    LEFT JOIN mt5_account_ownership_history own
      ON own.trading_account_id = so.trading_account_id AND own.user_id = so.user_id
      AND own.ended_at IS NULL
    WHERE d.signal_id = ? AND d.user_id <> ?
      AND d.execution_status = 'success'
      AND COALESCE(so.system_magic, ?) = ?
      AND 1 = (SELECT COUNT(*) FROM signal_outcomes active_outcomes
        WHERE active_outcomes.delivery_id = d.id
          AND active_outcomes.order_intent_id = d.order_intent_id
          AND active_outcomes.status IN (?, ?))
    ORDER BY d.id, so.id`, [PLATFORM_SHARED_POSITION_SOURCE, ...OPEN_OUTCOME_STATUSES,
    Number(signalId), Number(sourceUserId), ADMIN_SYSTEM_POSITION_MAGIC, ADMIN_SYSTEM_POSITION_MAGIC,
    ...OPEN_OUTCOME_STATUSES])
}

function uniqueSignalIds(rows) {
  return [...new Set(rows.map(row => Number(row.root_signal_id || row.signal_id)).filter(Number.isSafeInteger))]
}

async function validateOwnership(target) {
  const account = await dbOne(`SELECT ta.id AS trading_account_id, ta.user_id,
      ta.broker_server, ta.login_account, ta.is_deleted,
      own.id AS ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key, own.login_account AS ownership_login_account
    FROM trading_accounts ta
    LEFT JOIN mt5_account_ownership_history own
      ON own.trading_account_id = ta.id AND own.user_id = ta.user_id AND own.ended_at IS NULL
    WHERE ta.id = ? AND ta.user_id = ? AND ta.is_deleted = 0 LIMIT 1`, [Number(target.trading_account_id), Number(target.user_id)])
  if (!account || Number(account.ownership_user_id) !== Number(target.user_id)
    || Number(account.ownership_trading_account_id) !== Number(target.trading_account_id)
    || !account.ownership_history_id) return { ok: false, reason: 'ownership_unavailable', account }
  if (target.broker_server_key && text(target.broker_server_key).toUpperCase() !== text(account.broker_server_key || account.broker_server).toUpperCase()) {
    return { ok: false, reason: 'account_identity_changed', account }
  }
  if (target.login_account && text(target.login_account) !== text(account.ownership_login_account || account.login_account)) {
    return { ok: false, reason: 'account_identity_changed', account }
  }
  return { ok: true, account }
}

export async function validateAdminSystemPositionTarget(target, {
  bridge = null,
  inventoryResult = null,
  requireBridge = true,
} = {}) {
  if (!target || !target.ticket) return { ok: false, reason: 'ticket_unavailable' }
  const getGeneration = optionalModuleFunction(bridgeWs, 'getBridgeGeneration')
  const isAlive = optionalModuleFunction(bridgeWs, 'isBridgeAlive')
  const generation = getGeneration ? getGeneration(target.user_id) : target.bridge_generation
  if (requireBridge && isAlive && !isAlive(target.user_id)) {
    return { ok: false, reason: 'bridge_offline', generation }
  }
  if (target.bridge_generation != null && generation != null && Number(target.bridge_generation) !== Number(generation)) {
    return { ok: false, reason: 'bridge_generation_changed', generation }
  }
  let inventory = inventoryResult
  try {
    inventory = inventory || await readInventory(target.user_id, { bridge, expectedGeneration: generation })
  } catch (error) {
    return { ok: false, reason: error.code || 'inventory_unavailable', generation, error }
  }
  const accountServer = text(inventory?.account?.server)
  const accountLogin = text(inventory?.account?.login)
  if (target.broker_server_key && accountServer.toUpperCase() !== text(target.broker_server_key).toUpperCase()) {
    return { ok: false, reason: 'account_identity_changed', inventory, generation }
  }
  if (target.login_account && accountLogin !== text(target.login_account)) {
    return { ok: false, reason: 'account_identity_changed', inventory, generation }
  }
  const matches = (inventory.positions || []).filter(position => inventoryTargetMatches(position, target))
  if (matches.length !== 1) return { ok: false, reason: matches.length ? 'position_ambiguous' : 'position_not_found', inventory, generation }
  return { ok: true, inventory, position: matches[0], generation }
}

function dedupeTargets(targets) {
  const seen = new Map()
  const duplicateKeys = new Set()
  const duplicateTargets = []
  for (const target of targets) {
    const key = `${target.user_id}:${target.trading_account_id}:${target.ticket}`
    if (seen.has(key)) {
      duplicateKeys.add(key)
      duplicateTargets.push(target)
    }
    else seen.set(key, target)
  }
  return { targets: [...seen.values()], duplicateKeys, duplicateTargets }
}

function previewHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export async function resolveAdminSystemPositionTargets(actorUserId, sourceTicket, {
  bridge = null,
  includeSubscribers = true,
  requireBridge = true,
} = {}) {
  const actorId = Number(actorUserId)
  const wantedTicket = ticket(sourceTicket)
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw fail('actor_user_id_invalid')
  if (!wantedTicket) throw fail('position_ticket_required')

  const getGeneration = optionalModuleFunction(bridgeWs, 'getBridgeGeneration')
  const actorInventory = await readInventory(actorId, { bridge, expectedGeneration: getGeneration ? getGeneration(actorId) : null })
  const sourcePosition = (actorInventory.positions || []).find(item => inventoryTicket(item) === wantedTicket)
  if (!sourcePosition) throw fail('system_position_not_found')
  if (Number(sourcePosition.magic) !== ADMIN_SYSTEM_POSITION_MAGIC) throw fail('position_not_system_owned')
  const account = await loadCurrentAccount(actorId, actorInventory.account)
  if (!account) throw fail('source_account_identity_unavailable')
  const sourceCandidates = await loadSourceCandidates(actorId, account.trading_account_id, wantedTicket)
  const signalIds = uniqueSignalIds(sourceCandidates)
  if (signalIds.length !== 1) {
    throw fail(signalIds.length > 1 ? 'multiple_admin_dispatch_sources' : 'admin_dispatch_attribution_unavailable', {
      signal_ids: signalIds,
    })
  }
  const signalId = signalIds[0]
  const sourceRows = sourceCandidates.filter(row => Number(row.root_signal_id || row.signal_id) === signalId)
  const signalSources = new Set(sourceRows.map(row => text(row.signal_source)).filter(Boolean))
  if (signalSources.size !== 1) throw fail('system_position_attribution_ambiguous', { signal_id: signalId })
  const signalSource = [...signalSources][0]
  const outcomeIds = new Set(sourceRows.map(row => Number(row.outcome_id || row.id)).filter(Number.isSafeInteger))
  const sourceTargetIds = new Set(sourceRows.map(row => Number(row.admin_target_id || (text(row.target_role) === 'source' ? row.id : 0))).filter(Number.isSafeInteger))
  if (signalSource === ADMIN_SYSTEM_POSITION_SOURCE) {
    if (outcomeIds.size > 1 || sourceTargetIds.size > 1
      || (outcomeIds.size === 0 && sourceTargetIds.size !== 1)
      || (outcomeIds.size === 1 && sourceTargetIds.size !== 1)) {
      throw fail('admin_dispatch_attribution_ambiguous', { signal_id: signalId })
    }
  } else if (signalSource === PLATFORM_SHARED_POSITION_SOURCE) {
    if (outcomeIds.size !== 1 || sourceRows.some(row => Number(row.observer_source_user_id) !== actorId
      || Number(row.observer_strategy_id) !== Number(row.signal_strategy_id))) {
      throw fail('platform_signal_attribution_ambiguous', { signal_id: signalId })
    }
  } else {
    throw fail('system_position_source_unsupported', { signal_id: signalId, source:signalSource })
  }
  const sourceRow = sourceRows.find(row => text(row.target_role) === 'source') || sourceRows[0]
  const source = decodeTarget({ ...sourceRow, target_role: 'source', trade_ticket: wantedTicket,
    standard_symbol: sourceRow.standard_symbol || sourcePosition.symbol,
    direction: sourceRow.direction || sourcePosition.type,
    volume: sourceRow.volume ?? sourcePosition.volume,
    bridge_generation: sourceRow.bridge_generation ?? (getGeneration ? getGeneration(actorId) : null),
  }, { sourceSignalId: signalId })
  source.user_id = actorId
  source.trading_account_id = Number(account.trading_account_id)
  source.ownership_history_id = Number(account.ownership_history_id)
  source.broker_server_key = text(account.ownership_broker_server_key || account.broker_server_key || account.broker_server)
  source.login_account = text(account.ownership_login_account || account.login_account)
  source.symbol = text(source.symbol || sourcePosition.symbol)
  source.direction = direction(source.direction || sourcePosition.type)
  source.volume = Number(sourcePosition.volume || source.volume || 0)
  source.magic = ADMIN_SYSTEM_POSITION_MAGIC
  source.bridge_connected = bridgeConnected(source, source.target_snapshot)
  source.inclusion_status = 'source_only'
  source.reason_code = null
  const sourceValidation = await validateAdminSystemPositionTarget(source, { bridge, inventoryResult: actorInventory, requireBridge })
  if (!sourceValidation.ok) throw fail(`source_${sourceValidation.reason}`, { target: source })

  const exclusions = []
  let targets = [source]
  if (includeSubscribers) {
    const rows = signalSource === PLATFORM_SHARED_POSITION_SOURCE
      ? await loadPlatformDeliveryTargets(signalId, actorId)
      : await loadDispatchTargets(signalId)
    const decoded = rows.filter(row => text(row.target_role) === 'subscriber').map(row => decodeTarget(row, { sourceSignalId: signalId }))
    const deduped = dedupeTargets(decoded)
    for (const duplicateTarget of deduped.duplicateTargets) {
      const key = `${duplicateTarget.user_id}:${duplicateTarget.trading_account_id}:${duplicateTarget.ticket}`
      exclusions.push(exclusionTarget(duplicateTarget, 'duplicate_target', { key }))
    }
    // Keep a key-only record for a legacy row that cannot be decoded into a
    // target identity.  Normal duplicate rows are emitted above with the
    // account/user display fields required by the preview contract.
    for (const duplicateKey of deduped.duplicateKeys) {
      if (!deduped.duplicateTargets.some(target => `${target.user_id}:${target.trading_account_id}:${target.ticket}` === duplicateKey)) {
        exclusions.push({ reason:'duplicate_target', reason_code:'duplicate_target', inclusion_status:'excluded', key:duplicateKey })
      }
    }
    for (const target of deduped.targets) {
      if (!target.ticket) {
        exclusions.push(exclusionTarget(target, 'ticket_unavailable'))
        continue
      }
      const ownership = await validateOwnership(target).catch(error => ({ ok: false, reason: error.code || 'ownership_query_failed', error }))
      if (!ownership.ok) {
        exclusions.push(exclusionTarget(target, ownership.reason))
        continue
      }
      target.ownership_history_id = Number(ownership.account.ownership_history_id)
      target.broker_server_key = text(ownership.account.broker_server_key || ownership.account.broker_server)
      target.login_account = text(ownership.account.ownership_login_account || ownership.account.login_account)
      const validation = await validateAdminSystemPositionTarget(target, { bridge, requireBridge })
      if (!validation.ok) {
        exclusions.push(exclusionTarget(target, validation.reason))
        continue
      }
      target.eligible = true
      target.position = validation.position
      target.bridge_generation = validation.generation
      target.inclusion_status = 'included'
      target.reason_code = null
      targets.push(target)
    }
  }
  targets = targets.map((target, index) => ({
    ...target,
    ...displayFields(target, {
      inclusionStatus:target.is_source ? 'source_only' : 'included',
      reasonCode:null,
    }),
    eligible:target.eligible !== false,
    target_order:target.is_source ? targets.length : index,
  }))
    .sort((a, b) => Number(a.is_source) - Number(b.is_source) || Number(a.user_id) - Number(b.user_id) || Number(a.id) - Number(b.id))
  const payload = {
    actor_user_id: actorId, source_signal_id: signalId, source_ticket: wantedTicket,
    source: [source.user_id, source.trading_account_id, source.ticket, source.symbol, source.direction, source.volume],
    targets: targets.map(target => [target.target_role, target.user_id, target.trading_account_id, target.ticket, target.symbol, target.direction, target.volume, target.bridge_generation]),
    exclusions: exclusions.map(item => [item.user_id, item.trading_account_id, item.ticket, item.reason]),
  }
  return {
    ok: true,
    enabled: true,
    eligible: true,
    can_close: true,
    unique_attribution: true,
    attribution: { source: signalSource, unique_attribution: true, signal_id: signalId, dispatch_id: source.dispatch_id },
    source,
    source_signal_id: signalId,
    source_ticket: wantedTicket,
    targets,
    exclusions,
    preview_hash: previewHash(payload),
    summary: {
      target_count: targets.length, eligible_target_count: targets.filter(target => target.eligible).length,
      excluded_target_count: exclusions.length,
      subscriber_users: new Set(targets.filter(target => !target.is_source).map(target => target.user_id)).size,
      subscriber_positions: targets.filter(target => !target.is_source).length,
    },
  }
}

async function loadActiveTargetsForUser(userId) {
  return dbAll(`SELECT t.*, d.actor_user_id, d.status AS dispatch_status,
      s.source AS signal_source, s.id AS root_signal_id,
      so.id AS outcome_id, so.status AS outcome_status,
      so.position_id AS outcome_position_id, so.entry_order_ticket AS outcome_entry_order_ticket,
      so.system_magic AS outcome_system_magic, so.trading_account_id AS outcome_trading_account_id,
      so.symbol AS outcome_symbol, so.entry_direction AS outcome_direction,
      so.expected_volume AS outcome_volume,
      ta.broker_server AS account_broker_server, ta.login_account AS account_login_account,
      ta.nickname AS account_name,
      identity_user.email AS user_email, identity_user.nickname AS user_nickname,
      own.id AS current_ownership_history_id, own.user_id AS ownership_user_id,
      own.trading_account_id AS ownership_trading_account_id,
      own.broker_server_key AS current_broker_server_key,
      own.login_account AS current_login_account
    FROM admin_strategy_trade_targets t
    JOIN admin_strategy_trade_dispatches d ON d.id = t.dispatch_id
    JOIN ai_signals s ON s.id = t.signal_id AND s.source = ?
    LEFT JOIN signal_outcomes so ON so.id = (
      SELECT latest.id FROM signal_outcomes latest
      WHERE latest.signal_id = t.signal_id AND latest.user_id = t.user_id
        AND latest.trading_account_id = t.trading_account_id
        AND (latest.position_id = t.trade_ticket OR latest.entry_order_ticket = t.trade_ticket)
      ORDER BY latest.id DESC LIMIT 1)
    LEFT JOIN order_intents oi ON oi.id = t.order_intent_id
    LEFT JOIN trading_accounts ta ON ta.id = t.trading_account_id AND ta.user_id = t.user_id AND ta.is_deleted = 0
    LEFT JOIN users identity_user ON identity_user.id = t.user_id
    LEFT JOIN mt5_account_ownership_history own ON own.trading_account_id = t.trading_account_id
      AND own.user_id = t.user_id AND own.ended_at IS NULL
    WHERE t.user_id = ? AND t.status IN (?, ?, ?, ?, ?, ?, ?)
      AND d.status IN (?, ?, ?, ?)
      AND (so.status IN (?, ?) OR (so.id IS NULL AND (t.status IN (?, ?, ?, ?, ?) OR oi.status IN (?, ?, ?, ?, ?))))
    AND (so.id IS NOT NULL OR t.updated_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR) OR oi.status IN (?, ?, ?, ?))
    ORDER BY t.id`, [ADMIN_SYSTEM_POSITION_SOURCE, Number(userId), ...ACTIVE_TARGET_STATUSES, ...ACTIVE_DISPATCH_STATUSES,
    ...OPEN_OUTCOME_STATUSES, 'pending', 'validating', 'executing', 'delivering', 'uncertain',
    'preparing', 'prepared', 'bridge_sending', 'uncertain', 'succeeded',
    'preparing', 'prepared', 'bridge_sending', 'uncertain'])
}

export async function resolveAdminDispatchExemptions(userId, inventory, { failClosedOnError = true } = {}) {
  try {
    const rows = await loadActiveTargetsForUser(userId)
    if (!rows.length) return { status: 'ok', active: false, exemptions: [], exclusions: [] }
    const positions = Array.isArray(inventory?.positions) ? inventory.positions : []
    const exemptions = []
    const exclusions = []
    const matchedTickets = new Map()
    for (const row of rows) {
      const target = decodeTarget(row, { sourceSignalId: Number(row.root_signal_id || row.signal_id) })
      const ownershipOk = Number(row.ownership_user_id) === Number(userId)
        && Number(row.ownership_trading_account_id) === Number(target.trading_account_id)
        && row.current_ownership_history_id
      if (!ownershipOk) return { status: 'fail_closed', active: true, reason: 'ownership_unavailable', exemptions: [], exclusions: [target] }
      target.broker_server_key = text(row.current_broker_server_key || row.account_broker_server || target.broker_server_key)
      target.login_account = text(row.current_login_account || row.account_login_account || target.login_account)
      const matches = positions.filter(position => inventoryTargetMatches(position, target))
      if (!matches.length) return { status: 'fail_closed', active: true, reason: 'active_target_not_uniquely_mapped', target, exemptions: [], exclusions: [target] }
      if (matches.length !== 1) return { status: 'fail_closed', active: true, reason: 'active_target_inventory_ambiguous', target, exemptions: [], exclusions: [target] }
      const positionTicket = inventoryTicket(matches[0])
      const existing = matchedTickets.get(positionTicket)
      if (existing && (existing.signal_id !== target.signal_id || existing.id !== target.id)) {
        return { status: 'fail_closed', active: true, reason: 'admin_target_ticket_ambiguous', target, exemptions: [], exclusions: [target] }
      }
      matchedTickets.set(positionTicket, target)
      exemptions.push({ ...target, position: matches[0] })
    }
    return { status: 'ok', active: true, exemptions, exclusions }
  } catch (error) {
    if (!failClosedOnError) return { status: 'unavailable', active: false, reason: error.code || error.message, exemptions: [], exclusions: [] }
    return { status: 'fail_closed', active: true, reason: error.code || 'admin_dispatch_attribution_query_unavailable', exemptions: [], exclusions: [] }
  }
}

export const __adminSystemPositionTargetTest = {
  direction, symbol, inventoryTicket, sameNumber, decodeTarget, dedupeTargets,
}
