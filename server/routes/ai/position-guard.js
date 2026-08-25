import crypto from 'node:crypto'
import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

export const POSITION_GUARD_PROFILE_STATUSES = Object.freeze(['active', 'inactive'])
export const POSITION_GUARD_DECISION_SOURCE = 'pivot_guard'

const MAX_PRICE_DISTANCE = 1_000_000_000
const CONFIG_GROUPS = Object.freeze({
  break_stop: Object.freeze(['enabled', 'distance_price', 'open_near_price']),
  pivot_cross_stop: Object.freeze(['enabled', 'distance_price', 'min_duration_seconds']),
  retrace_stop: Object.freeze(['enabled', 'distance_price']),
  pivot_take_profit: Object.freeze(['enabled', 'tolerance_price', 'close_percent', 'move_break_even']),
  first_target_take_profit: Object.freeze([
    'enabled', 'tolerance_price', 'close_percent', 'move_break_even', 'break_even_offset_price',
  ]),
})

const DEFAULT_POSITION_GUARD_CONFIG_VALUE = {
  pivot_method: 'fibonacci',
  break_stop: { enabled: true, distance_price: 9, open_near_price: 10 },
  pivot_cross_stop: { enabled: true, distance_price: 8, min_duration_seconds: 3 },
  retrace_stop: { enabled: true, distance_price: 5 },
  pivot_take_profit: { enabled: true, tolerance_price: 3, close_percent: 50, move_break_even: true },
  first_target_take_profit: {
    enabled: true, tolerance_price: 3, close_percent: 50,
    move_break_even: true, break_even_offset_price: 2,
  },
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export const DEFAULT_POSITION_GUARD_CONFIG = deepFreeze(DEFAULT_POSITION_GUARD_CONFIG_VALUE)

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

export function stablePositionGuardJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function positionGuardConfigHash(config) {
  return crypto.createHash('sha256').update(stablePositionGuardJson(config)).digest('hex')
}

export const DEFAULT_POSITION_GUARD_CONFIG_HASH = positionGuardConfigHash(DEFAULT_POSITION_GUARD_CONFIG)

function positionGuardError(code, details = null) {
  const error = new Error(code)
  error.code = code
  if (details) error.details = details
  return error
}

function requirePositiveId(value, code) {
  if (value === null || value === undefined || value === '' || !/^\d+$/.test(String(value))) {
    throw positionGuardError(code)
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw positionGuardError(code)
  return id
}

function normalizedSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase()
  if (!symbol || symbol.length > 64 || !/^[A-Z0-9][A-Z0-9._-]*$/.test(symbol)) {
    throw positionGuardError('position_guard_symbol_invalid')
  }
  return symbol
}

function normalizedText(value, code, maxLength = 1000) {
  const text = String(value || '').trim()
  if (!text) throw positionGuardError(code)
  return text.slice(0, maxLength)
}

function normalizedOptionalText(value, maxLength = 1000) {
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : null
}

function normalizedBoolean(value, code) {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1') return true
    if (text === 'false' || text === '0') return false
  }
  throw positionGuardError(code)
}

function normalizedFinitePositive(value, field) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_PRICE_DISTANCE) {
    throw positionGuardError(`position_guard_config_invalid:${field}`)
  }
  return parsed
}

function normalizedPercent(value, field) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw positionGuardError(`position_guard_config_invalid:${field}`)
  }
  return parsed
}

function normalizedDuration(value, field) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60) {
    throw positionGuardError(`position_guard_config_invalid:${field}`)
  }
  return parsed
}

function assertRecord(value, field = 'config') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw positionGuardError(`position_guard_config_invalid:${field}`)
  }
  return value
}

function assertKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw positionGuardError(`position_guard_config_unknown:${field}.${key}`)
  }
}

/**
 * Normalize and validate only the administrator-controlled PivotGuard fields.
 * Max-loss, drawdown and runtime/transport controls are intentionally rejected
 * instead of silently being accepted as inert configuration.
 */
export function normalizePositionGuardConfig(rawConfig = {}, { allowDefaults = false } = {}) {
  const input = assertRecord(rawConfig)
  const allowedTopLevel = ['pivot_method', ...Object.keys(CONFIG_GROUPS)]
  assertKnownKeys(input, allowedTopLevel, 'config')
  if (!allowDefaults) {
    for (const key of allowedTopLevel) {
      if (input[key] === undefined) throw positionGuardError(`position_guard_config_missing:${key}`)
    }
  }

  const pivotMethod = input.pivot_method === undefined
    ? DEFAULT_POSITION_GUARD_CONFIG.pivot_method
    : String(input.pivot_method || '').trim().toLowerCase()
  if (!['fibonacci', 'standard'].includes(pivotMethod)) {
    throw positionGuardError('position_guard_config_invalid:pivot_method')
  }

  const result = { pivot_method: pivotMethod }
  for (const [group, fields] of Object.entries(CONFIG_GROUPS)) {
    const source = input[group] === undefined ? {} : assertRecord(input[group], group)
    assertKnownKeys(source, fields, group)
    const defaults = DEFAULT_POSITION_GUARD_CONFIG[group]
    const normalized = {}
    for (const field of fields) {
      if (!allowDefaults && source[field] === undefined) {
        throw positionGuardError(`position_guard_config_missing:${group}.${field}`)
      }
      const value = source[field] === undefined ? defaults[field] : source[field]
      const key = `${group}.${field}`
      if (field === 'enabled' || field === 'move_break_even') normalized[field] = normalizedBoolean(value, `position_guard_config_invalid:${key}`)
      else if (field === 'close_percent') normalized[field] = normalizedPercent(value, key)
      else if (field === 'min_duration_seconds') normalized[field] = normalizedDuration(value, key)
      else normalized[field] = normalizedFinitePositive(value, key)
    }
    result[group] = normalized
  }
  return result
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function adapterFrom(db = null) {
  const source = db || {}
  const one = source.one || source.queryOne || queryOne
  const all = source.all || source.queryAll || queryAll
  const execute = source.execute || source.queryRun || queryRun
  const transaction = source.transaction || (callback => withTransaction(async run => {
    const tx = {
      one: async (sql, params = []) => {
        const [rows] = await run(sql, params)
        return Array.isArray(rows) && rows.length ? rows[0] : null
      },
      all: async (sql, params = []) => {
        const [rows] = await run(sql, params)
        return rows
      },
      execute: async (sql, params = []) => {
        const [result] = await run(sql, params)
        return { changes: Number(result?.affectedRows || 0), insertId: Number(result?.insertId || 0) }
      },
    }
    return callback(tx)
  }))
  return {
    one: (...args) => one(...args),
    all: (...args) => all(...args),
    execute: async (...args) => {
      const result = await execute(...args)
      if (Array.isArray(result)) {
        const item = result[0] || {}
        return { changes: Number(item.affectedRows || 0), insertId: Number(item.insertId || 0) }
      }
      return { changes: Number(result?.changes ?? result?.affectedRows ?? 0), insertId: Number(result?.insertId || 0) }
    },
    transaction,
  }
}

async function assertAdministrator(db, userId) {
  const id = requirePositiveId(userId, 'position_guard_admin_required')
  const row = await db.one(`SELECT id, role, deletion_status, deleted_at
    FROM users WHERE id = ? AND role = 'admin'
      AND (deletion_status IS NULL OR deletion_status = 'active') AND deleted_at IS NULL`, [id])
  if (!row) throw positionGuardError('position_guard_admin_required')
  return id
}

async function assertOwnedActiveAccount(db, userId, tradingAccountId) {
  const ownerId = requirePositiveId(userId, 'position_guard_user_required')
  const accountId = requirePositiveId(tradingAccountId, 'position_guard_trading_account_required')
  const row = await db.one(`SELECT id, user_id, is_deleted, observe_status
    FROM trading_accounts
    WHERE id = ? AND user_id = ? AND is_deleted = 0 AND observe_status = 'active'`, [accountId, ownerId])
  if (!row) throw positionGuardError('position_guard_account_not_owned_or_inactive')
  return { userId: ownerId, tradingAccountId: accountId, account: row }
}

function publicUserSetting({ userId, tradingAccountId, row = null }) {
  return {
    user_id: Number(userId),
    trading_account_id: Number(tradingAccountId),
    enabled: Number(row?.enabled || 0) === 1,
    enabled_at: row?.enabled_at || null,
    disabled_at: row?.disabled_at || null,
    updated_at: row?.updated_at || null,
  }
}

export async function getUserPositionGuardSetting({ userId, tradingAccountId, db = null } = {}) {
  const adapter = adapterFrom(db)
  const account = await assertOwnedActiveAccount(adapter, userId, tradingAccountId)
  const row = await adapter.one(`SELECT user_id, trading_account_id, enabled, enabled_at, disabled_at, updated_at
    FROM user_position_guard_settings WHERE user_id = ? AND trading_account_id = ?`,
  [account.userId, account.tradingAccountId])
  return publicUserSetting({ userId: account.userId, tradingAccountId: account.tradingAccountId, row })
}

export async function saveUserPositionGuardSetting({
  userId, tradingAccountId, enabled, db = null, now = beijingNow(),
} = {}) {
  const adapter = adapterFrom(db)
  const account = await assertOwnedActiveAccount(adapter, userId, tradingAccountId)
  const normalized = normalizedBoolean(enabled, 'position_guard_enabled_invalid')
  if (normalized) {
    const profile = await adapter.one(`SELECT id FROM position_guard_profiles
      WHERE status = 'active' AND current_version_id IS NOT NULL LIMIT 1`)
    if (!profile) throw positionGuardError('position_guard_profile_not_found')
  }
  await adapter.execute(`INSERT INTO user_position_guard_settings
    (user_id, trading_account_id, enabled, enabled_at, disabled_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      enabled = VALUES(enabled), enabled_at = VALUES(enabled_at),
      disabled_at = VALUES(disabled_at), updated_at = VALUES(updated_at)`, [
    account.userId, account.tradingAccountId, normalized ? 1 : 0,
    normalized ? now : null, normalized ? null : now, now,
  ])
  return publicUserSetting({
    userId: account.userId,
    tradingAccountId: account.tradingAccountId,
    row: { enabled: normalized ? 1 : 0, enabled_at: normalized ? now : null, disabled_at: normalized ? null : now, updated_at: now },
  })
}

function publicGlobalControl(row = null) {
  return {
    id: 1,
    enabled: Number(row?.enabled || 0) === 1,
    changed_by: row?.changed_by == null ? null : Number(row.changed_by),
    reason: row?.reason || null,
    updated_at: row?.updated_at || null,
  }
}

export async function getPositionGuardGlobalControl({ db = null } = {}) {
  const adapter = adapterFrom(db)
  return publicGlobalControl(await adapter.one(`SELECT id, enabled, changed_by, reason, updated_at
    FROM global_position_guard_control WHERE id = 1`))
}

export async function savePositionGuardGlobalControl({
  adminUserId, enabled, reason, db = null, now = beijingNow(),
} = {}) {
  const adapter = adapterFrom(db)
  const changedBy = await assertAdministrator(adapter, adminUserId)
  const normalized = normalizedBoolean(enabled, 'position_guard_enabled_invalid')
  const normalizedReason = normalizedOptionalText(reason)
  if (normalized && !normalizedReason) throw positionGuardError('position_guard_enable_reason_required')
  await adapter.execute(`INSERT INTO global_position_guard_control
    (id, enabled, changed_by, reason, updated_at) VALUES (1, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), changed_by = VALUES(changed_by),
      reason = VALUES(reason), updated_at = VALUES(updated_at)`,
  [normalized ? 1 : 0, changedBy, normalizedReason, now])
  return publicGlobalControl({ id: 1, enabled: normalized ? 1 : 0, changed_by: changedBy, reason: normalizedReason, updated_at: now })
}

function parseProfileRow(row, { includeConfig = false } = {}) {
  if (!row) return null
  const profile = {
    id: Number(row.id),
    standard_symbol: String(row.standard_symbol || '').toUpperCase(),
    status: String(row.status || 'inactive'),
    current_version_id: row.current_version_id == null ? null : Number(row.current_version_id),
    changed_by: row.changed_by == null ? null : Number(row.changed_by),
    reason: row.reason || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    version_id: row.version_id == null ? null : Number(row.version_id),
    version_no: row.version_no == null ? null : Number(row.version_no),
    config_hash: row.config_hash || null,
    version_reason: row.version_reason || null,
    created_by: row.created_by == null ? null : Number(row.created_by),
    version_created_at: row.version_created_at || null,
  }
  if (includeConfig) profile.config = parseJson(row.config_json, null)
  return profile
}

const PROFILE_SELECT = `SELECT profiles.id, profiles.standard_symbol, profiles.status,
    profiles.current_version_id, profiles.changed_by, profiles.reason, profiles.created_at,
    profiles.updated_at, versions.id AS version_id, versions.version_no,
    versions.config_json, versions.config_hash, versions.reason AS version_reason,
    versions.created_by, versions.created_at AS version_created_at
  FROM position_guard_profiles profiles
  LEFT JOIN position_guard_profile_versions versions ON versions.id = profiles.current_version_id`

export async function listPositionGuardProfiles({
  includeConfig = false, adminUserId = null, db = null,
} = {}) {
  const adapter = adapterFrom(db)
  if (includeConfig) await assertAdministrator(adapter, adminUserId)
  const rows = await adapter.all(`${PROFILE_SELECT} ORDER BY profiles.standard_symbol`)
  return rows.map(row => parseProfileRow(row, { includeConfig }))
}

export async function getPositionGuardProfile({
  standardSymbol, includeConfig = false, adminUserId = null, onlyActive = false, db = null,
} = {}) {
  const adapter = adapterFrom(db)
  if (includeConfig) await assertAdministrator(adapter, adminUserId)
  const symbol = normalizedSymbol(standardSymbol)
  const activeClause = onlyActive ? " AND profiles.status = 'active'" : ''
  const row = await adapter.one(`${PROFILE_SELECT}
    WHERE profiles.standard_symbol = ?${activeClause} LIMIT 1`, [symbol])
  return parseProfileRow(row, { includeConfig })
}

/** Internal read used by the future deterministic monitor; it includes config. */
export async function getCurrentPositionGuardProfile({ standardSymbol, db = null } = {}) {
  const adapter = adapterFrom(db)
  const symbol = normalizedSymbol(standardSymbol)
  const row = await adapter.one(`${PROFILE_SELECT}
    WHERE profiles.standard_symbol = ? AND profiles.status = 'active'
      AND profiles.current_version_id IS NOT NULL LIMIT 1`, [symbol])
  if (!row || !row.version_id || !row.config_json) return null
  return parseProfileRow(row, { includeConfig: true })
}

export async function savePositionGuardProfile({
  adminUserId, standardSymbol, config, status, reason, db = null, now = beijingNow(),
} = {}) {
  const adapter = adapterFrom(db)
  const changedBy = await assertAdministrator(adapter, adminUserId)
  const symbol = normalizedSymbol(standardSymbol)
  const normalizedConfig = normalizePositionGuardConfig(config)
  const normalizedReason = normalizedText(reason, 'position_guard_change_reason_required')
  const normalizedStatus = status === undefined || status === null || status === ''
    ? null : String(status).trim().toLowerCase()
  if (normalizedStatus && !POSITION_GUARD_PROFILE_STATUSES.includes(normalizedStatus)) {
    throw positionGuardError('position_guard_profile_status_invalid')
  }
  const configJson = stablePositionGuardJson(normalizedConfig)
  const configHash = positionGuardConfigHash(normalizedConfig)

  return adapter.transaction(async tx => {
    await tx.execute(`INSERT INTO position_guard_profiles
      (standard_symbol, status, current_version_id, changed_by, reason, created_at, updated_at)
      VALUES (?, COALESCE(?, 'active'), NULL, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE standard_symbol = VALUES(standard_symbol)`,
    [symbol, normalizedStatus, changedBy, normalizedReason, now, now])
    const profile = await tx.one(`SELECT id, standard_symbol, status, current_version_id,
        changed_by, reason, created_at, updated_at
      FROM position_guard_profiles WHERE standard_symbol = ? FOR UPDATE`, [symbol])
    if (!profile) throw positionGuardError('position_guard_profile_not_found')
    const latest = await tx.one(`SELECT version_no FROM position_guard_profile_versions
      WHERE profile_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE`, [profile.id])
    const versionNo = Number(latest?.version_no || 0) + 1
    const inserted = await tx.execute(`INSERT INTO position_guard_profile_versions
      (profile_id, version_no, config_json, config_hash, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [profile.id, versionNo, configJson, configHash, normalizedReason, changedBy, now])
    const version = await tx.one(`SELECT id, profile_id, version_no, config_json, config_hash,
        reason, created_by, created_at
      FROM position_guard_profile_versions WHERE profile_id = ? AND version_no = ? FOR UPDATE`,
    [profile.id, versionNo])
    const versionId = Number(inserted?.insertId || version?.id || 0)
    if (!versionId) throw positionGuardError('position_guard_profile_version_insert_failed')
    await tx.execute(`UPDATE position_guard_profiles
      SET current_version_id = ?, status = COALESCE(?, status), changed_by = ?, reason = ?, updated_at = ?
      WHERE id = ?`, [versionId, normalizedStatus, changedBy, normalizedReason, now, profile.id])
    return parseProfileRow({
      ...profile,
      status: normalizedStatus || profile.status || 'active',
      current_version_id: versionId,
      changed_by: changedBy,
      reason: normalizedReason,
      updated_at: now,
      version_id: versionId,
      version_no: versionNo,
      config_json: configJson,
      config_hash: configHash,
      version_reason: normalizedReason,
      created_by: changedBy,
      version_created_at: now,
    }, { includeConfig: true })
  })
}

/**
 * Return only accounts with an explicit user opt-in and current ownership.
 * The binding join is intentional: a previous user's setting must not survive
 * account takeover as an active monitor target.
 */
export async function listEnabledPositionGuardAccounts({ db = null } = {}) {
  const adapter = adapterFrom(db)
  const rows = await adapter.all(`SELECT DISTINCT settings.user_id, settings.trading_account_id,
      settings.enabled_at, settings.updated_at, accounts.broker_server, accounts.login_account,
      bindings.broker_server_key, bindings.login_account AS binding_login_account,
      ownership.id AS ownership_history_id
    FROM user_position_guard_settings settings
    INNER JOIN trading_accounts accounts
      ON accounts.id = settings.trading_account_id AND accounts.user_id = settings.user_id
      AND accounts.is_deleted = 0 AND accounts.observe_status = 'active'
    INNER JOIN mt5_account_bindings bindings
      ON bindings.current_user_id = settings.user_id
      AND bindings.current_trading_account_id = settings.trading_account_id
    INNER JOIN mt5_account_ownership_history ownership
      ON ownership.id = (
        SELECT MAX(current_ownership.id)
        FROM mt5_account_ownership_history current_ownership
        WHERE current_ownership.trading_account_id = settings.trading_account_id
          AND current_ownership.user_id = settings.user_id
          AND current_ownership.ended_at IS NULL
      )
    WHERE settings.enabled = 1
    ORDER BY settings.user_id, settings.trading_account_id`)
  return rows.map(row => ({
    user_id: Number(row.user_id),
    trading_account_id: Number(row.trading_account_id),
    enabled_at: row.enabled_at || null,
    updated_at: row.updated_at || null,
    broker_server: row.broker_server || null,
    login_account: row.login_account || null,
    broker_server_key: row.broker_server_key || null,
    ownership_history_id: row.ownership_history_id == null ? null : Number(row.ownership_history_id),
  }))
}

export async function listCurrentPositionGuardProfiles({ symbols = null, db = null } = {}) {
  const adapter = adapterFrom(db)
  const normalizedSymbols = symbols == null ? null : [...new Set((Array.isArray(symbols) ? symbols : [symbols]).map(normalizedSymbol))]
  const params = []
  let clause = ` WHERE profiles.status = 'active' AND profiles.current_version_id IS NOT NULL`
  if (normalizedSymbols) {
    if (!normalizedSymbols.length) return []
    clause += ` AND profiles.standard_symbol IN (${normalizedSymbols.map(() => '?').join(',')})`
    params.push(...normalizedSymbols)
  }
  const rows = await adapter.all(`${PROFILE_SELECT}${clause} ORDER BY profiles.standard_symbol`, params)
  return rows.filter(row => row.version_id && row.config_json).map(row => parseProfileRow(row, { includeConfig: true }))
}

export const _positionGuardInternals = Object.freeze({
  normalizedBoolean,
  normalizedSymbol,
  positionGuardError,
  adapterFrom,
})

// Keep the plural/set naming available to route callers while retaining the
// singular names used by the monitor internals.
export const getUserPositionGuardSettings = getUserPositionGuardSetting
export const setUserPositionGuardSettings = saveUserPositionGuardSetting
export const getGlobalPositionGuardControl = getPositionGuardGlobalControl
export const saveGlobalPositionGuardControl = savePositionGuardGlobalControl
export const listPositionGuardProfilesForAdmin = listPositionGuardProfiles
export const savePositionGuardProfileVersion = savePositionGuardProfile
export const validatePositionGuardConfig = normalizePositionGuardConfig
