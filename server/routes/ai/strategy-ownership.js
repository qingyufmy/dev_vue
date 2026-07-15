// ai/strategy-ownership.js — 策略所有权、可见性、模型绑定和订阅管理

import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { parsePromptSymbols } from './config.js'
import { getModelProfileById } from './model-profiles.js'
import { stripBrokerSuffix } from './utils.js'

const VALID_SCOPES = new Set(['platform', 'private'])
const VALID_VISIBILITY = new Set(['active', 'draft', 'archived'])
const VALID_MEMORY_MODES = new Set(['shared', 'isolated'])
const VALID_MARGIN_MODES = new Set(['unknown', 'netting', 'hedging'])

function toId(value, field = 'id') {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid_${field}`)
  return id
}

function isAdmin(role) {
  return role === 'admin'
}

function normalizeMarginMode(value) {
  const mode = String(value || 'unknown').toLowerCase()
  const normalized = mode === 'hedge' ? 'hedging' : mode
  if (!VALID_MARGIN_MODES.has(normalized)) throw new Error('invalid_margin_mode')
  return normalized
}

function normalizeSymbol(value) {
  return stripBrokerSuffix(String(value || '').trim()).toUpperCase()
}

function parseSymbols(value) {
  return [...new Set(parsePromptSymbols(value || '[]').map(normalizeSymbol).filter(Boolean))]
}

function normalizeRequestedSymbols(value, strategySymbolsJson) {
  if (value == null || (Array.isArray(value) && value.length === 0)) return null
  if (!Array.isArray(value)) throw new Error('invalid_symbols')
  const allowed = new Set(parseSymbols(strategySymbolsJson))
  const normalized = [...new Set(value.map(normalizeSymbol).filter(Boolean))]
  if (normalized.length === 0) return null
  const invalid = normalized.filter(symbol => !allowed.has(symbol))
  if (invalid.length) throw new Error(`symbols_not_in_strategy:${invalid.join(',')}`)
  return JSON.stringify(normalized)
}

function effectiveSymbols(subscriptionSymbolsJson, strategySymbolsJson) {
  return parseSymbols(subscriptionSymbolsJson == null ? strategySymbolsJson : subscriptionSymbolsJson)
}

function hasCurrentPro(row) {
  if (!row) return false
  if (row.role === 'admin') return true
  if (row.has_pro_access !== undefined) return Boolean(Number(row.has_pro_access))
  if (row.plan !== 'pro') return false
  return !row.plan_expires_at || new Date(row.plan_expires_at) >= new Date()
}

async function assertProAccess(userId, userRole) {
  if (isAdmin(userRole)) return
  const row = await queryOne(
    `SELECT role, plan, plan_expires_at,
       (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
     FROM users WHERE id = ?`,
    [toId(userId, 'user_id')]
  )
  if (!hasCurrentPro(row)) throw new Error('pro_access_required')
}

async function txAll(run, sql, params = []) {
  const [rows] = await run(sql, params)
  return rows
}

async function txOne(run, sql, params = []) {
  const rows = await txAll(run, sql, params)
  return rows[0] || null
}

async function assertTxProAccess(run, userId, userRole) {
  if (isAdmin(userRole)) return
  const row = await txOne(
    run,
    `SELECT role, plan, plan_expires_at,
       (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS has_pro_access
     FROM users WHERE id = ?`,
    [userId]
  )
  if (!hasCurrentPro(row)) throw new Error('pro_access_required')
}

async function validateModelBinding(scope, ownerUserId, modelProfileId) {
  if (scope === 'platform') {
    if (modelProfileId != null) throw new Error('platform_strategy_uses_platform_default_model')
    return { modelProfileId: null, inferenceMode: 'platform_model' }
  }
  if (modelProfileId == null || modelProfileId === '') {
    return { modelProfileId: null, inferenceMode: 'user_default' }
  }
  const id = toId(modelProfileId, 'model_profile_id')
  const profile = await getModelProfileById(id)
  if (!profile || profile.status !== 'active') throw new Error('model_profile_not_found_or_inactive')
  if (profile.scope !== 'user' || Number(profile.owner_user_id) !== ownerUserId) {
    throw new Error('model_profile_access_denied')
  }
  return { modelProfileId: id, inferenceMode: 'owner_model' }
}

function canViewStrategy(strategy, userId, userRole) {
  if (isAdmin(userRole)) return true
  if (strategy.scope === 'platform') return strategy.visibility_status === 'active'
  return strategy.scope === 'private' && Number(strategy.owner_user_id) === userId
}

function assertStrategyExecutable(strategy, userId) {
  if (!strategy || strategy.deleted_at || strategy.visibility_status !== 'active' || !Number(strategy.is_active)) {
    throw new Error('strategy_not_active')
  }
  if (strategy.scope === 'private' && Number(strategy.owner_user_id) !== userId) {
    throw new Error('strategy_not_selectable')
  }
}

// ─── Strategy CRUD ───

export async function listStrategies(userId, userRole, opts = {}) {
  const actorId = toId(userId, 'user_id')
  await assertProAccess(actorId, userRole)
  const params = []
  const where = ['apt.deleted_at IS NULL']
  if (opts.scope != null) {
    if (!VALID_SCOPES.has(opts.scope)) throw new Error('invalid_scope')
    where.push('apt.scope = ?')
    params.push(opts.scope)
  }
  if (!isAdmin(userRole)) {
    if (opts.includeInactive) {
      where.push("((apt.scope = 'platform' AND apt.visibility_status = 'active') OR (apt.scope = 'private' AND apt.owner_user_id = ?))")
    } else {
      where.push("apt.visibility_status = 'active' AND (apt.scope = 'platform' OR (apt.scope = 'private' AND apt.owner_user_id = ?))")
    }
    params.push(actorId)
  }
  return queryAll(
    `SELECT apt.*, u.nickname AS owner_nickname
     FROM auto_prompt_types apt
     LEFT JOIN users u ON u.id = apt.owner_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY apt.scope ASC, apt.sort_order ASC, apt.id ASC`,
    params
  )
}

export async function getStrategyById(strategyId, userId, userRole, opts = {}) {
  const id = toId(strategyId, 'strategy_id')
  const actorId = toId(userId, 'user_id')
  await assertProAccess(actorId, userRole)
  const row = await queryOne(
    `SELECT apt.*, u.nickname AS owner_nickname
     FROM auto_prompt_types apt LEFT JOIN users u ON u.id = apt.owner_user_id
     WHERE apt.id = ? AND apt.deleted_at IS NULL`,
    [id]
  )
  if (!row || !canViewStrategy(row, actorId, userRole)) return null
  if (opts.forExecution) {
    try { assertStrategyExecutable(row, actorId) } catch { return null }
  }
  return row
}

export async function createStrategy(userId, userRole, payload = {}) {
  const actorId = toId(userId, 'user_id')
  await assertProAccess(actorId, userRole)
  const scope = payload.scope || 'private'
  if (!VALID_SCOPES.has(scope)) throw new Error('invalid_scope')
  if (scope === 'platform' && !isAdmin(userRole)) throw new Error('platform_requires_admin')
  const visibility = payload.visibility_status || 'active'
  if (!VALID_VISIBILITY.has(visibility)) throw new Error('invalid_visibility_status')
  const symbols = [...new Set((Array.isArray(payload.symbols) ? payload.symbols : []).map(normalizeSymbol).filter(Boolean))]
  if (!symbols.length) throw new Error('symbols_required')
  const ownerUserId = scope === 'platform' ? 0 : actorId
  const binding = await validateModelBinding(scope, ownerUserId, payload.model_profile_id)
  const now = beijingNow()
  const result = await queryRun(
    `INSERT INTO auto_prompt_types
      (title, description, system_prompt, symbols_json, interval_minutes, is_active, sort_order,
       created_by, scope, owner_user_id, model_profile_id, inference_mode, visibility_status,
       version, version_label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      payload.title || '未命名策略', payload.description || '', payload.system_prompt || '',
      JSON.stringify(symbols), Math.max(1, Number(payload.interval_minutes) || 5),
      payload.is_active === false ? 0 : 1, Number(payload.sort_order) || 0, actorId,
      scope, ownerUserId, binding.modelProfileId, binding.inferenceMode, visibility,
      payload.version_label || '', now, now,
    ]
  )
  return getStrategyById(result.insertId, actorId, userRole)
}

export async function updateStrategy(strategyId, userId, userRole, payload = {}) {
  const id = toId(strategyId, 'strategy_id')
  const actorId = toId(userId, 'user_id')
  await assertProAccess(actorId, userRole)
  const existing = await queryOne('SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('strategy_not_found')
  if (existing.scope === 'platform') {
    if (!isAdmin(userRole)) throw new Error('access_denied')
  } else if (Number(existing.owner_user_id) !== actorId) {
    throw new Error('access_denied')
  }
  if (payload.scope !== undefined && payload.scope !== existing.scope) throw new Error('strategy_scope_immutable')
  if (payload.owner_user_id !== undefined && Number(payload.owner_user_id) !== Number(existing.owner_user_id)) {
    throw new Error('strategy_owner_immutable')
  }
  const visibility = payload.visibility_status ?? existing.visibility_status
  if (!VALID_VISIBILITY.has(visibility)) throw new Error('invalid_visibility_status')
  let symbolsJson = existing.symbols_json
  if (payload.symbols !== undefined) {
    const symbols = [...new Set((Array.isArray(payload.symbols) ? payload.symbols : []).map(normalizeSymbol).filter(Boolean))]
    if (!symbols.length) throw new Error('symbols_required')
    symbolsJson = JSON.stringify(symbols)
  }
  const requestedModelId = payload.model_profile_id !== undefined ? payload.model_profile_id : existing.model_profile_id
  const binding = await validateModelBinding(existing.scope, Number(existing.owner_user_id), requestedModelId)
  const contentChanged = payload.title !== undefined || payload.system_prompt !== undefined || payload.symbols !== undefined
  const version = contentChanged ? Number(existing.version || 1) + 1 : Number(existing.version || 1)
  const now = beijingNow()
  await queryRun(
    `UPDATE auto_prompt_types SET title = ?, description = ?, system_prompt = ?, symbols_json = ?,
       interval_minutes = ?, is_active = ?, sort_order = ?, model_profile_id = ?, inference_mode = ?,
       visibility_status = ?, version = ?, version_label = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.title ?? existing.title, payload.description ?? existing.description,
      payload.system_prompt ?? existing.system_prompt, symbolsJson,
      payload.interval_minutes != null ? Math.max(1, Number(payload.interval_minutes) || 1) : existing.interval_minutes,
      payload.is_active !== undefined ? (payload.is_active ? 1 : 0) : existing.is_active,
      payload.sort_order != null ? Number(payload.sort_order) || 0 : existing.sort_order,
      binding.modelProfileId, binding.inferenceMode, visibility, version,
      payload.version_label ?? existing.version_label, now, id,
    ]
  )
  return getStrategyById(id, actorId, userRole)
}

export async function deleteStrategy(strategyId, userId, userRole) {
  const id = toId(strategyId, 'strategy_id')
  const actorId = toId(userId, 'user_id')
  const existing = await queryOne('SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [id])
  if (!existing) throw new Error('strategy_not_found')
  if (existing.scope === 'platform' ? !isAdmin(userRole) : Number(existing.owner_user_id) !== actorId) {
    throw new Error('access_denied')
  }
  await queryRun(
    "UPDATE auto_prompt_types SET deleted_at = ?, is_active = 0, visibility_status = 'archived' WHERE id = ?",
    [beijingNow(), id]
  )
}

// ─── Trading accounts ───

export async function listTradingAccounts(userId) {
  return queryAll('SELECT * FROM trading_accounts WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC', [toId(userId, 'user_id')])
}

export async function getTradingAccountById(accountId, userId) {
  return queryOne('SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0', [toId(accountId, 'account_id'), toId(userId, 'user_id')])
}

export async function createTradingAccount(userId, payload = {}) {
  const actorId = toId(userId, 'user_id')
  const brokerServer = String(payload.broker_server || '').trim()
  const loginAccount = String(payload.login_account || '').trim()
  if (!brokerServer) throw new Error('broker_server_required')
  if (!loginAccount) throw new Error('login_account_required')
  const now = beijingNow()
  const result = await queryRun(
    `INSERT INTO trading_accounts
      (user_id, broker_server, login_account, nickname, margin_mode, review_status, observe_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'active', ?, ?)`,
    [actorId, brokerServer, loginAccount, String(payload.nickname || ''), normalizeMarginMode(payload.margin_mode), now, now]
  )
  return queryOne('SELECT * FROM trading_accounts WHERE id = ?', [result.insertId])
}

export async function updateTradingAccount(accountId, userId, payload = {}) {
  const id = toId(accountId, 'account_id')
  const actorId = toId(userId, 'user_id')
  if (payload.review_status !== undefined || payload.observe_status !== undefined) {
    throw new Error('account_control_fields_read_only')
  }
  const existing = await queryOne('SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0', [id, actorId])
  if (!existing) throw new Error('account_not_found')
  const marginMode = payload.margin_mode !== undefined ? normalizeMarginMode(payload.margin_mode) : existing.margin_mode
  await queryRun(
    `UPDATE trading_accounts SET broker_server = ?, login_account = ?, nickname = ?, margin_mode = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    [
      payload.broker_server ?? existing.broker_server, payload.login_account ?? existing.login_account,
      payload.nickname ?? existing.nickname, marginMode, beijingNow(), id, actorId,
    ]
  )
  return queryOne('SELECT * FROM trading_accounts WHERE id = ?', [id])
}

export async function deleteTradingAccount(accountId, userId) {
  const id = toId(accountId, 'account_id')
  const actorId = toId(userId, 'user_id')
  const existing = await queryOne('SELECT id FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0', [id, actorId])
  if (!existing) throw new Error('account_not_found')
  const now = beijingNow()
  await withTransaction(async run => {
    await run('UPDATE trading_accounts SET is_deleted = 1, updated_at = ? WHERE id = ? AND user_id = ?', [now, id, actorId])
    await run('UPDATE strategy_subscriptions SET is_deleted = 1, execution_enabled = 0, updated_at = ? WHERE trading_account_id = ?', [now, id])
  })
}

// ─── Strategy subscriptions ───

export async function listSubscriptions(userId, userRole, opts = {}) {
  const actorId = toId(userId, 'user_id')
  await assertProAccess(actorId, userRole)
  const targetUserId = opts.targetUserId == null ? actorId : toId(opts.targetUserId, 'target_user_id')
  if (!isAdmin(userRole) && targetUserId !== actorId) throw new Error('access_denied')
  return queryAll(
    `SELECT ss.*, apt.title AS strategy_title, apt.scope AS strategy_scope,
            ta.broker_server, ta.login_account, ta.nickname AS account_nickname
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     JOIN trading_accounts ta ON ta.id = ss.trading_account_id AND ta.is_deleted = 0
     WHERE ss.user_id = ? AND ss.is_deleted = 0 ORDER BY ss.created_at DESC`,
    [targetUserId]
  )
}

async function loadExecutableStrategyTx(run, strategyId, userId) {
  const strategy = await txOne(run, 'SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [strategyId])
  if (!strategy) throw new Error('strategy_not_found_or_not_visible')
  assertStrategyExecutable(strategy, userId)
  return strategy
}

async function assertNoExecutionConflictTx(run, accountId, symbols, excludeSubscriptionId = null) {
  const rows = await txAll(
    run,
    `SELECT ss.id, ss.symbols_json, apt.symbols_json AS strategy_symbols_json
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     WHERE ss.trading_account_id = ? AND ss.execution_enabled = 1 AND ss.is_deleted = 0
     FOR UPDATE`,
    [accountId]
  )
  const wanted = new Set(symbols)
  for (const row of rows) {
    if (excludeSubscriptionId != null && Number(row.id) === excludeSubscriptionId) continue
    const overlap = effectiveSymbols(row.symbols_json, row.strategy_symbols_json).filter(symbol => wanted.has(symbol))
    if (overlap.length) throw new Error(`execution_conflict:${row.id}:${overlap.join(',')}`)
  }
}

export async function createSubscription(userId, userRole, payload = {}) {
  const actorId = toId(userId, 'user_id')
  if (payload.trading_account_id == null) throw new Error('trading_account_id_required')
  if (payload.strategy_id == null) throw new Error('strategy_id_required')
  const accountId = toId(payload.trading_account_id, 'trading_account_id')
  const strategyId = toId(payload.strategy_id, 'strategy_id')
  const memoryMode = payload.memory_mode || 'isolated'
  if (!VALID_MEMORY_MODES.has(memoryMode)) throw new Error('invalid_memory_mode')
  const result = await withTransaction(async run => {
    await assertTxProAccess(run, actorId, userRole)
    const account = await txOne(run, 'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE', [accountId, actorId])
    if (!account) throw new Error('account_not_found')
    const strategy = await loadExecutableStrategyTx(run, strategyId, actorId)
    const symbolsJson = normalizeRequestedSymbols(payload.symbols, strategy.symbols_json)
    const executionEnabled = payload.execution_enabled ? 1 : 0
    if (executionEnabled) {
      await assertNoExecutionConflictTx(run, accountId, effectiveSymbols(symbolsJson, strategy.symbols_json))
    }
    const [insert] = await run(
      `INSERT INTO strategy_subscriptions
        (user_id, trading_account_id, strategy_id, risk_profile_id, symbols_json,
         execution_enabled, memory_mode, conflicting_strategy_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actorId, accountId, strategyId, payload.risk_profile_id || null, symbolsJson,
        executionEnabled, memoryMode, payload.conflicting_strategy_id || null, beijingNow(), beijingNow(),
      ]
    )
    return insert.insertId
  })
  return queryOne('SELECT * FROM strategy_subscriptions WHERE id = ?', [result])
}

export async function updateSubscription(subscriptionId, userId, userRole, payload = {}) {
  const id = toId(subscriptionId, 'subscription_id')
  const actorId = toId(userId, 'user_id')
  const locator = await queryOne('SELECT trading_account_id FROM strategy_subscriptions WHERE id = ? AND user_id = ? AND is_deleted = 0', [id, actorId])
  if (!locator) throw new Error('subscription_not_found')
  const accountId = Number(locator.trading_account_id)
  await withTransaction(async run => {
    await assertTxProAccess(run, actorId, userRole)
    const account = await txOne(run, 'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE', [accountId, actorId])
    if (!account) throw new Error('account_not_found')
    const existing = await txOne(run, 'SELECT * FROM strategy_subscriptions WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE', [id, actorId])
    if (!existing) throw new Error('subscription_not_found')
    const strategy = await loadExecutableStrategyTx(run, Number(existing.strategy_id), actorId)
    const symbolsJson = payload.symbols === undefined
      ? existing.symbols_json
      : normalizeRequestedSymbols(payload.symbols, strategy.symbols_json)
    const executionEnabled = payload.execution_enabled === undefined ? Number(existing.execution_enabled) : (payload.execution_enabled ? 1 : 0)
    const memoryMode = payload.memory_mode ?? existing.memory_mode
    if (!VALID_MEMORY_MODES.has(memoryMode)) throw new Error('invalid_memory_mode')
    if (executionEnabled) {
      await assertNoExecutionConflictTx(run, accountId, effectiveSymbols(symbolsJson, strategy.symbols_json), id)
    }
    await run(
      `UPDATE strategy_subscriptions SET risk_profile_id = ?, symbols_json = ?, execution_enabled = ?,
         memory_mode = ?, conflicting_strategy_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      [
        payload.risk_profile_id !== undefined ? payload.risk_profile_id : existing.risk_profile_id,
        symbolsJson, executionEnabled, memoryMode,
        payload.conflicting_strategy_id !== undefined ? payload.conflicting_strategy_id : existing.conflicting_strategy_id,
        beijingNow(), id, actorId,
      ]
    )
  })
  return queryOne('SELECT * FROM strategy_subscriptions WHERE id = ?', [id])
}

export async function deleteSubscription(subscriptionId, userId) {
  const id = toId(subscriptionId, 'subscription_id')
  const actorId = toId(userId, 'user_id')
  const result = await queryRun(
    'UPDATE strategy_subscriptions SET is_deleted = 1, execution_enabled = 0, updated_at = ? WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [beijingNow(), id, actorId]
  )
  if (!result.changes) throw new Error('subscription_not_found')
}

export async function adminListUserStrategies(actorUserId, actorRole, targetUserId) {
  toId(actorUserId, 'user_id')
  if (!isAdmin(actorRole)) throw new Error('admin_required')
  return queryAll(
    `SELECT apt.*, u.nickname AS owner_nickname FROM auto_prompt_types apt
     LEFT JOIN users u ON u.id = apt.owner_user_id
     WHERE apt.owner_user_id = ? AND apt.deleted_at IS NULL ORDER BY apt.created_at DESC`,
    [toId(targetUserId, 'target_user_id')]
  )
}

export async function adminListUserSubscriptions(actorUserId, actorRole, targetUserId) {
  toId(actorUserId, 'user_id')
  if (!isAdmin(actorRole)) throw new Error('admin_required')
  return listSubscriptions(actorUserId, actorRole, { targetUserId })
}

export async function getSubscriptionWithContext(subscriptionId, userId, userRole) {
  const id = toId(subscriptionId, 'subscription_id')
  const actorId = toId(userId, 'user_id')
  const sub = await queryOne(
    `SELECT ss.*, apt.title AS strategy_title, apt.scope AS strategy_scope,
            apt.system_prompt, apt.symbols_json AS strategy_symbols_json,
            apt.model_profile_id AS strategy_model_profile_id, apt.inference_mode,
            ta.broker_server, ta.login_account, ta.nickname AS account_nickname,
            ta.margin_mode, ta.review_status, ta.observe_status,
            u.nickname AS owner_nickname
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     JOIN trading_accounts ta ON ta.id = ss.trading_account_id AND ta.is_deleted = 0
     JOIN users u ON u.id = ss.user_id
     WHERE ss.id = ? AND ss.is_deleted = 0`,
    [id]
  )
  if (!sub || (!isAdmin(userRole) && Number(sub.user_id) !== actorId)) return null
  return sub
}
