// ai/strategy-ownership.js — 策略所有权、可见性、模型绑定、订阅管理

import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from '../../db.js'
import { parsePromptSymbols } from './config.js'
import { getModelProfileById } from './model-profiles.js'

// === Constants ===
const VALID_SCOPES = ['platform', 'private']
const VALID_INFERENCE_MODES = ['platform_model', 'owner_model', 'user_default']
const VALID_VISIBILITY = ['active', 'draft', 'archived']
const VALID_MEMORY_MODES = ['shared', 'isolated']
const VALID_REVIEW_STATUS = ['pending', 'approved', 'rejected']
const VALID_OBSERVE_STATUS = ['active', 'paused']

// === Helper: Check if user is admin ===
function isAdmin(user) {
  return user && user.role === 'admin'
}

// === Helper: Check if user has pro access ===
function hasProAccess(user) {
  if (!user) return false
  if (user.role === 'admin') return true
  return user.plan === 'pro' && (!user.plan_expires_at || new Date(user.plan_expires_at) >= new Date())
}

// === Helper: Normalize symbol (strip broker suffix for comparison) ===
function normalizeSymbol(sym) {
  return String(sym || '').toUpperCase().replace(/\.([A-Z0-9]+)$/i, '').trim()
}

// === Strategy CRUD ===

/**
 * List strategies visible to a user.
 * Platform strategies: visible to all pro+ users.
 * Private strategies: visible to creator + admins only.
 */
export async function listStrategies(userId, userRole, opts = {}) {
  const { includeInactive = false, scope = null } = opts
  const conditions = ['apt.deleted_at IS NULL']
  if (!includeInactive) {
    conditions.push('apt.visibility_status = "active"')
  }

  if (scope) {
    if (!VALID_SCOPES.includes(scope)) throw new Error('invalid_scope')
    conditions.push(`apt.scope = '${scope}'`)
  }

  // Permission filter: platform strategies visible to all pro+; private only to creator + admin
  const isAdm = userRole === 'admin'
  if (!isAdm) {
    conditions.push(`(
      apt.scope = 'platform'
      OR (apt.scope = 'private' AND apt.owner_user_id = ${parseInt(userId) || 0})
    )`)
  } else {
    conditions.push(`(
      apt.scope = 'platform'
      OR apt.owner_user_id = ${parseInt(userId) || 0}
    )`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return await queryAll(
    `SELECT apt.*, u.nickname AS owner_nickname
     FROM auto_prompt_types apt
     LEFT JOIN users u ON u.id = apt.owner_user_id
     ${where}
     ORDER BY apt.scope ASC, apt.sort_order ASC, apt.id ASC`
  )
}

/**
 * Get a single strategy by ID with ownership check.
 * Returns null if not found or not visible to user.
 */
export async function getStrategyById(strategyId, userId, userRole) {
  const row = await queryOne(
    'SELECT apt.*, u.nickname AS owner_nickname FROM auto_prompt_types apt LEFT JOIN users u ON u.id = apt.owner_user_id WHERE apt.id = ? AND apt.deleted_at IS NULL',
    [strategyId]
  )
  if (!row) return null
  // Visibility check
  if (row.scope === 'platform') return row
  if (row.owner_user_id === userId || userRole === 'admin') return row
  return null
}

/**
 * Create a new strategy (private only; platform strategies are admin-only via saveAutoPromptType).
 */
export async function createStrategy(userId, userRole, payload) {
  const now = beijingNow()
  const scope = payload.scope || 'private'
  if (!VALID_SCOPES.includes(scope)) throw new Error('invalid_scope')
  if (scope === 'platform' && userRole !== 'admin') throw new Error('platform_requires_admin')
  if (scope === 'private') {
    const user = await queryOne('SELECT role, plan, plan_expires_at FROM users WHERE id = ?', [userId])
    if (!hasProAccess(user)) throw new Error('private_requires_pro')
  }

  // Validate symbols
  let symbols = Array.isArray(payload.symbols) ? payload.symbols : []
  symbols = symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean)
  const uniqueSymbols = [...new Set(symbols)]
  if (uniqueSymbols.length === 0) throw new Error('symbols_required')

  // Validate inference_mode
  const inferenceMode = payload.inference_mode || 'platform_model'
  if (!VALID_INFERENCE_MODES.includes(inferenceMode)) throw new Error('invalid_inference_mode')

  // Validate model_profile_id if provided
  if (payload.model_profile_id) {
    const profile = await getModelProfileById(payload.model_profile_id)
    if (!profile) throw new Error('model_profile_not_found')
    if (scope === 'private' && profile.owner_user_id !== userId && userRole !== 'admin') {
      throw new Error('model_profile_access_denied')
    }
  }

  const intervalMinutes = Math.max(1, Number(payload.interval_minutes) || 5)
  const ownerUserId = scope === 'platform' ? 0 : userId

  const result = await queryRun(
    `INSERT INTO auto_prompt_types
      (title, description, system_prompt, symbols_json, interval_minutes, is_active, sort_order,
       created_by, scope, owner_user_id, model_profile_id, inference_mode, visibility_status,
       version, version_label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      payload.title || '未命名策略',
      payload.description || '',
      payload.system_prompt || '',
      JSON.stringify(uniqueSymbols),
      intervalMinutes,
      payload.is_active !== undefined ? (payload.is_active ? 1 : 0) : 1,
      payload.sort_order || 0,
      userId,
      scope,
      ownerUserId,
      payload.model_profile_id || null,
      inferenceMode,
      payload.visibility_status || 'active',
      payload.version_label || '',
      now, now,
    ]
  )

  return await queryOne(
    'SELECT apt.*, u.nickname AS owner_nickname FROM auto_prompt_types apt LEFT JOIN users u ON u.id = apt.owner_user_id WHERE apt.id = ?',
    [result.insertId]
  )
}

/**
 * Update an existing strategy. Only owner or admin can update.
 */
export async function updateStrategy(strategyId, userId, userRole, payload) {
  const now = beijingNow()
  const existing = await queryOne(
    'SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL',
    [strategyId]
  )
  if (!existing) throw new Error('strategy_not_found')
  if (existing.owner_user_id !== userId && userRole !== 'admin') throw new Error('access_denied')

  // Validate symbols if provided
  let symbolsUpdate = null
  if (payload.symbols !== undefined) {
    let symbols = Array.isArray(payload.symbols) ? payload.symbols : []
    symbols = symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean)
    const uniqueSymbols = [...new Set(symbols)]
    if (uniqueSymbols.length === 0) throw new Error('symbols_required')
    symbolsUpdate = JSON.stringify(uniqueSymbols)
  }

  // Validate inference_mode if provided
  if (payload.inference_mode && !VALID_INFERENCE_MODES.includes(payload.inference_mode)) {
    throw new Error('invalid_inference_mode')
  }

  // Validate visibility_status if provided
  if (payload.visibility_status && !VALID_VISIBILITY.includes(payload.visibility_status)) {
    throw new Error('invalid_visibility_status')
  }

  // Validate model_profile_id if provided
  if (payload.model_profile_id !== undefined && payload.model_profile_id !== null) {
    const profile = await getModelProfileById(payload.model_profile_id)
    if (!profile) throw new Error('model_profile_not_found')
    if (existing.scope === 'private' && profile.owner_user_id !== userId && userRole !== 'admin') {
      throw new Error('model_profile_access_denied')
    }
  }

  // Bump version if content changes
  const contentChanged = payload.system_prompt !== undefined || symbolsUpdate !== null || payload.title !== undefined
  const nextVersion = contentChanged ? (existing.version || 1) + 1 : (existing.version || 1)

  await queryRun(
    `UPDATE auto_prompt_types SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      system_prompt = COALESCE(?, system_prompt),
      symbols_json = COALESCE(?, symbols_json),
      interval_minutes = COALESCE(?, interval_minutes),
      is_active = COALESCE(?, is_active),
      sort_order = COALESCE(?, sort_order),
      model_profile_id = ?,
      inference_mode = COALESCE(?, inference_mode),
      visibility_status = COALESCE(?, visibility_status),
      version = ?,
      version_label = COALESCE(?, version_label),
      updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [
      payload.title ?? null,
      payload.description ?? null,
      payload.system_prompt ?? null,
      symbolsUpdate,
      payload.interval_minutes != null ? Math.max(1, Number(payload.interval_minutes)) : null,
      payload.is_active !== undefined ? (payload.is_active ? 1 : 0) : null,
      payload.sort_order ?? null,
      payload.model_profile_id !== undefined ? payload.model_profile_id : existing.model_profile_id,
      payload.inference_mode ?? null,
      payload.visibility_status ?? null,
      nextVersion,
      payload.version_label ?? null,
      now, strategyId,
    ]
  )

  return await queryOne(
    'SELECT apt.*, u.nickname AS owner_nickname FROM auto_prompt_types apt LEFT JOIN users u ON u.id = apt.owner_user_id WHERE apt.id = ?',
    [strategyId]
  )
}

/**
 * Soft-delete a strategy. Only owner or admin can delete.
 */
export async function deleteStrategy(strategyId, userId, userRole) {
  const now = beijingNow()
  const existing = await queryOne(
    'SELECT * FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL',
    [strategyId]
  )
  if (!existing) throw new Error('strategy_not_found')
  if (existing.owner_user_id !== userId && userRole !== 'admin') throw new Error('access_denied')

  await queryRun(
    'UPDATE auto_prompt_types SET deleted_at = ?, is_active = 0, visibility_status = ? WHERE id = ?',
    [now, 'archived', strategyId]
  )
}

// === Trading Accounts ===

export async function listTradingAccounts(userId) {
  return await queryAll(
    'SELECT * FROM trading_accounts WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at DESC',
    [userId]
  )
}

export async function getTradingAccountById(accountId, userId) {
  const row = await queryOne(
    'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [accountId, userId]
  )
  return row || null
}

export async function createTradingAccount(userId, payload) {
  const now = beijingNow()
  const brokerServer = String(payload.broker_server || '').trim()
  const loginAccount = String(payload.login_account || '').trim()
  if (!brokerServer) throw new Error('broker_server_required')
  if (!loginAccount) throw new Error('login_account_required')

  const marginMode = payload.margin_mode || 'netting'
  const result = await queryRun(
    `INSERT INTO trading_accounts (user_id, broker_server, login_account, nickname, margin_mode, review_status, observe_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      brokerServer,
      loginAccount,
      payload.nickname || '',
      marginMode,
      payload.review_status || 'pending',
      payload.observe_status || 'active',
      now, now,
    ]
  )
  return await queryOne('SELECT * FROM trading_accounts WHERE id = ?', [result.insertId])
}

export async function updateTradingAccount(accountId, userId, payload) {
  const now = beijingNow()
  const existing = await queryOne(
    'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [accountId, userId]
  )
  if (!existing) throw new Error('account_not_found')

  await queryRun(
    `UPDATE trading_accounts SET
      broker_server = COALESCE(?, broker_server),
      login_account = COALESCE(?, login_account),
      nickname = COALESCE(?, nickname),
      margin_mode = COALESCE(?, margin_mode),
      review_status = COALESCE(?, review_status),
      observe_status = COALESCE(?, observe_status),
      updated_at = ?
     WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    [
      payload.broker_server ?? null,
      payload.login_account ?? null,
      payload.nickname ?? null,
      payload.margin_mode ?? null,
      payload.review_status ?? null,
      payload.observe_status ?? null,
      now, accountId, userId,
    ]
  )
  return await queryOne('SELECT * FROM trading_accounts WHERE id = ?', [accountId])
}

export async function deleteTradingAccount(accountId, userId) {
  const now = beijingNow()
  const existing = await queryOne(
    'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [accountId, userId]
  )
  if (!existing) throw new Error('account_not_found')

  // Soft-delete account and related subscriptions
  await withTransaction(async run => {
    await run('UPDATE trading_accounts SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, accountId])
    await run('UPDATE strategy_subscriptions SET is_deleted = 1, updated_at = ? WHERE trading_account_id = ?', [now, accountId])
  })
}

// === Strategy Subscriptions ===

/**
 * List subscriptions for a user. Admins can filter by user_id.
 */
export async function listSubscriptions(userId, userRole, opts = {}) {
  const targetUserId = opts.targetUserId || userId
  const isAdm = userRole === 'admin'
  if (!isAdm && targetUserId !== userId) throw new Error('access_denied')

  return await queryAll(
    `SELECT ss.*, apt.title AS strategy_title, apt.scope AS strategy_scope,
            ta.broker_server, ta.login_account, ta.nickname AS account_nickname
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     JOIN trading_accounts ta ON ta.id = ss.trading_account_id AND ta.is_deleted = 0
     WHERE ss.user_id = ? AND ss.is_deleted = 0
     ORDER BY ss.created_at DESC`,
    [targetUserId]
  )
}

/**
 * V1 constraint: same trading_account + same normalized symbol → only one active execution_enabled subscription.
 * Returns the conflicting subscription if any.
 */
async function findActiveExecutionConflict(tradingAccountId, strategyId, excludeSubscriptionId = null) {
  const strategy = await queryOne('SELECT symbols_json FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [strategyId])
  if (!strategy) return null
  const strategySymbols = parsePromptSymbols(strategy.symbols_json || '[]')
  if (strategySymbols.length === 0) return null

  // Find all active execution subscriptions for this account
  const existing = await queryAll(
    'SELECT ss.*, apt.symbols_json AS existing_symbols_json FROM strategy_subscriptions ss JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL WHERE ss.trading_account_id = ? AND ss.execution_enabled = 1 AND ss.is_deleted = 0',
    [tradingAccountId]
  )

  for (const sub of existing) {
    if (excludeSubscriptionId && sub.id === excludeSubscriptionId) continue
    const existingSymbols = parsePromptSymbols(sub.existing_symbols_json || '[]')
    const overlap = strategySymbols.filter(s => existingSymbols.includes(s))
    if (overlap.length > 0) return { subscription: sub, overlappingSymbols: overlap }
  }
  return null
}

/**
 * Create a subscription. Validates V1 active execution constraint.
 */
export async function createSubscription(userId, userRole, payload) {
  const now = beijingNow()

  // Validate required fields
  if (!payload.trading_account_id) throw new Error('trading_account_id_required')
  if (!payload.strategy_id) throw new Error('strategy_id_required')

  // Verify trading account ownership
  const account = await queryOne(
    'SELECT * FROM trading_accounts WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [payload.trading_account_id, userId]
  )
  if (!account) throw new Error('account_not_found')

  // Verify strategy exists and is visible
  const strategy = await getStrategyById(payload.strategy_id, userId, userRole)
  if (!strategy) throw new Error('strategy_not_found_or_not_visible')

  // Validate symbols
  let symbolsJson = null
  if (payload.symbols !== undefined) {
    const strategySymbols = parsePromptSymbols(strategy.symbols_json || '[]')
    if (payload.symbols === null || (Array.isArray(payload.symbols) && payload.symbols.length === 0)) {
      symbolsJson = null // NULL = use all strategy symbols
    } else if (Array.isArray(payload.symbols)) {
      const normalized = [...new Set(payload.symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
      const invalid = normalized.filter(s => !strategySymbols.includes(s))
      if (invalid.length > 0) throw new Error(`symbols_not_in_strategy: ${invalid.join(', ')}`)
      symbolsJson = JSON.stringify(normalized)
    }
  }

  // Validate memory_mode
  const memoryMode = payload.memory_mode || 'shared'
  if (!VALID_MEMORY_MODES.includes(memoryMode)) throw new Error('invalid_memory_mode')

  // V1 constraint: check active execution conflict
  const executionEnabled = payload.execution_enabled ? 1 : 0
  if (executionEnabled) {
    const conflict = await findActiveExecutionConflict(payload.trading_account_id, payload.strategy_id)
    if (conflict) {
      throw new Error(`execution_conflict: account ${payload.trading_account_id} already has active execution for overlapping symbols [${conflict.overlappingSymbols.join(', ')}] in subscription #${conflict.subscription.id}`)
    }
  }

  const result = await queryRun(
    `INSERT INTO strategy_subscriptions
      (user_id, trading_account_id, strategy_id, risk_profile_id, symbols_json,
       execution_enabled, memory_mode, conflicting_strategy_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      payload.trading_account_id,
      payload.strategy_id,
      payload.risk_profile_id || null,
      symbolsJson,
      executionEnabled,
      memoryMode,
      payload.conflicting_strategy_id || null,
      now, now,
    ]
  )
  return await queryOne('SELECT * FROM strategy_subscriptions WHERE id = ?', [result.insertId])
}

/**
 * Update a subscription. Validates V1 constraint if enabling execution.
 */
export async function updateSubscription(subscriptionId, userId, userRole, payload) {
  const now = beijingNow()
  const existing = await queryOne(
    'SELECT * FROM strategy_subscriptions WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [subscriptionId, userId]
  )
  if (!existing) throw new Error('subscription_not_found')

  // If enabling execution, check V1 constraint
  const executionEnabled = payload.execution_enabled !== undefined ? (payload.execution_enabled ? 1 : 0) : existing.execution_enabled
  if (executionEnabled && !existing.execution_enabled) {
    const conflict = await findActiveExecutionConflict(existing.trading_account_id, existing.strategy_id, subscriptionId)
    if (conflict) {
      throw new Error(`execution_conflict: account ${existing.trading_account_id} already has active execution for overlapping symbols [${conflict.overlappingSymbols.join(', ')}] in subscription #${conflict.subscription.id}`)
    }
  }

  // Validate symbols if provided
  let symbolsUpdate = undefined
  if (payload.symbols !== undefined) {
    if (payload.symbols === null) {
      symbolsUpdate = null
    } else if (Array.isArray(payload.symbols)) {
      const strategy = await queryOne('SELECT symbols_json FROM auto_prompt_types WHERE id = ? AND deleted_at IS NULL', [existing.strategy_id])
      if (strategy) {
        const strategySymbols = parsePromptSymbols(strategy.symbols_json || '[]')
        const normalized = [...new Set(payload.symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))]
        const invalid = normalized.filter(s => !strategySymbols.includes(s))
        if (invalid.length > 0) throw new Error(`symbols_not_in_strategy: ${invalid.join(', ')}`)
        symbolsUpdate = JSON.stringify(normalized)
      }
    }
  }

  // Validate memory_mode if provided
  if (payload.memory_mode && !VALID_MEMORY_MODES.includes(payload.memory_mode)) {
    throw new Error('invalid_memory_mode')
  }

  await queryRun(
    `UPDATE strategy_subscriptions SET
      risk_profile_id = ?,
      symbols_json = ${symbolsUpdate !== undefined ? '?' : 'symbols_json'},
      execution_enabled = ?,
      memory_mode = COALESCE(?, memory_mode),
      conflicting_strategy_id = ?,
      updated_at = ?
     WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    [
      payload.risk_profile_id !== undefined ? payload.risk_profile_id : existing.risk_profile_id,
      ...(symbolsUpdate !== undefined ? [symbolsUpdate] : []),
      executionEnabled,
      payload.memory_mode ?? null,
      payload.conflicting_strategy_id !== undefined ? payload.conflicting_strategy_id : existing.conflicting_strategy_id,
      now, subscriptionId, userId,
    ]
  )
  return await queryOne('SELECT * FROM strategy_subscriptions WHERE id = ?', [subscriptionId])
}

/**
 * Soft-delete a subscription.
 */
export async function deleteSubscription(subscriptionId, userId) {
  const now = beijingNow()
  const existing = await queryOne(
    'SELECT * FROM strategy_subscriptions WHERE id = ? AND user_id = ? AND is_deleted = 0',
    [subscriptionId, userId]
  )
  if (!existing) throw new Error('subscription_not_found')

  await queryRun(
    'UPDATE strategy_subscriptions SET is_deleted = 1, updated_at = ? WHERE id = ?',
    [now, subscriptionId]
  )
}

/**
 * Admin read-only view: list a user's strategies without model/execution/modify permissions.
 */
export async function adminListUserStrategies(targetUserId) {
  return await queryAll(
    `SELECT apt.*, u.nickname AS owner_nickname
     FROM auto_prompt_types apt
     LEFT JOIN users u ON u.id = apt.owner_user_id
     WHERE apt.owner_user_id = ? AND apt.deleted_at IS NULL
     ORDER BY apt.created_at DESC`,
    [targetUserId]
  )
}

/**
 * Admin read-only view: list a user's subscriptions without model/execution/modify permissions.
 */
export async function adminListUserSubscriptions(targetUserId) {
  return await queryAll(
    `SELECT ss.*, apt.title AS strategy_title, apt.scope AS strategy_scope,
            ta.broker_server, ta.login_account, ta.nickname AS account_nickname
     FROM strategy_subscriptions ss
     JOIN auto_prompt_types apt ON apt.id = ss.strategy_id AND apt.deleted_at IS NULL
     JOIN trading_accounts ta ON ta.id = ss.trading_account_id AND ta.is_deleted = 0
     WHERE ss.user_id = ? AND ss.is_deleted = 0
     ORDER BY ss.created_at DESC`,
    [targetUserId]
  )
}

/**
 * Get subscription with full context (strategy + account + model profile info).
 */
export async function getSubscriptionWithContext(subscriptionId, userId, userRole) {
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
    [subscriptionId]
  )
  if (!sub) return null
  // Permission check: only owner or admin
  if (sub.user_id !== userId && userRole !== 'admin') return null
  return sub
}
