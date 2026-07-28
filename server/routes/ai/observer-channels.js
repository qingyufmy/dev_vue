import { queryAll, queryOne, queryRun, withTransaction } from '../../db.js'
import { SUBSCRIPTION_SCHEDULE_DEFAULTS } from './subscription-schedule.js'
import { stripBrokerSuffix } from './utils.js'

const SOURCE_STATUSES = new Set(['active', 'disabled'])
const CHANNEL_STATUSES = new Set(['active', 'disabled'])
const CHANNEL_AUDIENCES = new Set(['all', 'plus', 'pro', 'assigned'])
const viewerChannelCache = new Map()
const VIEWER_CHANNEL_CACHE_MS = 3000

export function invalidateObserverChannelCache() {
  viewerChannelCache.clear()
}

function requiredText(value, code, maxLength) {
  const text = String(value || '').trim()
  if (!text) throw new Error(code)
  return text.slice(0, maxLength)
}

function optionalText(value, maxLength) {
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : null
}

function normalizedStatus(value, allowed, fallback = 'active') {
  const status = String(value || fallback).trim().toLowerCase()
  if (!allowed.has(status)) throw new Error('invalid_status')
  return status
}

function normalizedBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback)
  if (typeof value === 'string') return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
  return Boolean(value)
}

function normalizedSlug(value) {
  const slug = requiredText(value, 'channel_slug_required', 64).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error('invalid_channel_slug')
  return slug
}

async function validateBridgeUser(bridgeUserId) {
  const id = Number(bridgeUserId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_bridge_user_id')
  const user = await queryOne(`SELECT id, role, plan, plan_expires_at, email, nickname,
      (role = 'admin' OR (plan = 'pro' AND (plan_expires_at IS NULL OR plan_expires_at >= NOW()))) AS bridge_eligible
    FROM users WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [id])
  if (!user) throw new Error('bridge_user_not_found')
  // A source operator is a dedicated Pro account or an administrator. This
  // preserves the existing signed Bridge login while avoiding extra admin
  // accounts for every observation source.
  if (!Number(user.bridge_eligible)) throw new Error('bridge_user_requires_pro')
  return user
}

async function validateTradingAccount(tradingAccountId, bridgeUserId) {
  if (tradingAccountId === undefined || tradingAccountId === null || tradingAccountId === '') {
    const current = await queryOne(`SELECT id FROM trading_accounts
      WHERE user_id = ? AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 1`, [bridgeUserId])
    if (!current) throw new Error('observer_source_trading_account_required')
    return Number(current.id)
  }
  const id = Number(tradingAccountId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_trading_account_id')
  const account = await queryOne(`SELECT id FROM trading_accounts
    WHERE id = ? AND user_id = ? AND is_deleted = 0`, [id, bridgeUserId])
  if (!account) throw new Error('trading_account_not_owned_by_source')
  return id
}

async function readObserverSourceRuntime(bridgeUserId, strategyId) {
  const [scheduler, bridgeSettings] = await Promise.all([
    queryOne(`SELECT enabled, enable_auto_trade FROM auto_scheduler
      WHERE user_id = ? AND prompt_type_id = ? LIMIT 1`, [bridgeUserId, strategyId]),
    queryOne(`SELECT trade_send_enabled, auto_reasoning_enabled FROM user_bridge_settings
      WHERE user_id = ? LIMIT 1`, [bridgeUserId]),
  ])
  return {
    auto_inference_enabled: normalizedBoolean(scheduler?.enabled, bridgeSettings?.auto_reasoning_enabled),
    trade_send_enabled: normalizedBoolean(bridgeSettings?.trade_send_enabled, scheduler?.enable_auto_trade),
  }
}

function transactionAdapter(run) {
  return {
    one: async (sql, params = []) => {
      const [rows] = await run(sql, params)
      return Array.isArray(rows) && rows.length ? rows[0] : null
    },
    execute: async (sql, params = []) => {
      const [result] = await run(sql, params)
      return { changes:Number(result?.affectedRows || 0), insertId:Number(result?.insertId || 0) }
    },
  }
}

// Resolve imported DB functions at call time so importing observer routing does
// not eagerly touch test/bootstrap adapters that have not finished initializing.
const directAdapter = {
  one:(...args) => queryOne(...args),
  execute:(...args) => queryRun(...args),
}

async function syncObserverSourceRuntime(bridgeUserId, tradingAccountId, strategyId, runtime = {}, db = directAdapter) {
  const strategy = await db.one(`SELECT id, symbols_json FROM auto_prompt_types
    WHERE id = ? AND scope = 'platform' AND is_active = 1 AND deleted_at IS NULL`, [strategyId])
  if (!strategy) throw new Error('observer_source_strategy_invalid')
  const autoInferenceEnabled = normalizedBoolean(runtime.auto_inference_enabled, true)
  const tradeSendEnabled = normalizedBoolean(runtime.trade_send_enabled, true)
  const existing = await db.one(`SELECT id FROM strategy_subscriptions
    WHERE user_id = ? AND strategy_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1`, [bridgeUserId, strategyId])
  if (existing) {
    await db.execute(`UPDATE strategy_subscriptions SET trading_account_id = ?, symbols_json = ?,
      execution_enabled = ?, memory_mode = 'platform_only', updated_at = NOW() WHERE id = ?`,
    [tradingAccountId, strategy.symbols_json, autoInferenceEnabled ? 1 : 0, existing.id])
  } else {
    const scheduleWeekdaysJson = JSON.stringify(SUBSCRIPTION_SCHEDULE_DEFAULTS.weekdays)
    const scheduleWindowsJson = JSON.stringify(SUBSCRIPTION_SCHEDULE_DEFAULTS.windows)
    await db.execute(`INSERT INTO strategy_subscriptions
      (user_id, trading_account_id, strategy_id, symbols_json, execution_enabled, memory_mode,
       schedule_enabled, schedule_timezone, schedule_weekdays_json, schedule_windows_json,
       outside_window_behavior, take_profit_mode, is_deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'platform_only', 0, ?, ?, ?, ?, 'ai_recommended', 0, NOW(), NOW())`,
    [
      bridgeUserId, tradingAccountId, strategyId, strategy.symbols_json, autoInferenceEnabled ? 1 : 0,
      SUBSCRIPTION_SCHEDULE_DEFAULTS.timezone, scheduleWeekdaysJson, scheduleWindowsJson,
      SUBSCRIPTION_SCHEDULE_DEFAULTS.outsideBehavior,
    ])
  }
  await db.execute(`INSERT INTO auto_scheduler
    (user_id, enabled, prompt_type_id, risk_level, max_position_size, selected_take_profit, enable_auto_trade, selected_symbols_json, created_at, updated_at)
    VALUES (?, ?, ?, 'medium', 0.05, 2, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), prompt_type_id = VALUES(prompt_type_id),
      enable_auto_trade = VALUES(enable_auto_trade), selected_symbols_json = VALUES(selected_symbols_json), updated_at = NOW()`,
  [bridgeUserId, autoInferenceEnabled ? 1 : 0, strategyId, tradeSendEnabled ? 1 : 0, strategy.symbols_json])
  await db.execute(`INSERT INTO user_bridge_settings
    (user_id, trade_send_enabled, auto_reasoning_enabled, updated_at)
    VALUES (?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE trade_send_enabled = VALUES(trade_send_enabled),
      auto_reasoning_enabled = VALUES(auto_reasoning_enabled), updated_at = NOW()`,
  [bridgeUserId, tradeSendEnabled ? 1 : 0, autoInferenceEnabled ? 1 : 0])
}

async function disableObserverSourceRuntime(bridgeUserId, strategyId, db = directAdapter) {
  await db.execute(`UPDATE strategy_subscriptions SET execution_enabled = 0, updated_at = NOW()
    WHERE user_id = ? AND strategy_id = ? AND is_deleted = 0`, [bridgeUserId, strategyId])
  await db.execute(`UPDATE auto_scheduler SET enabled = 0, updated_at = NOW()
    WHERE user_id = ? AND prompt_type_id = ?`, [bridgeUserId, strategyId])
  await db.execute(`UPDATE user_bridge_settings
    SET trade_send_enabled = 0, auto_reasoning_enabled = 0, updated_at = NOW()
    WHERE user_id = ?`, [bridgeUserId])
}

async function validatePlatformStrategy(strategyId, excludingSourceId = null) {
  const id = Number(strategyId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('observer_source_strategy_required')
  const strategy = await queryOne(`SELECT id, title FROM auto_prompt_types
    WHERE id = ? AND scope = 'platform' AND is_active = 1 AND deleted_at IS NULL`, [id])
  if (!strategy) throw new Error('observer_source_strategy_invalid')
  const params = [id]
  let exclusion = ''
  if (excludingSourceId) { exclusion = ' AND id <> ?'; params.push(Number(excludingSourceId)) }
  const duplicate = await queryOne(`SELECT id FROM ai_observer_sources
    WHERE strategy_id = ? AND status = 'active'${exclusion} LIMIT 1`, params)
  if (duplicate) throw new Error('observer_source_strategy_in_use')
  return id
}

export async function getObserverSourceForStrategy(strategyId) {
  return queryOne(`SELECT sources.id AS source_id, sources.name AS source_name,
      sources.bridge_user_id, sources.trading_account_id, sources.strategy_id
    FROM ai_observer_sources sources
    WHERE sources.strategy_id = ? AND sources.status = 'active'
    ORDER BY sources.updated_at DESC, sources.id DESC LIMIT 1`, [Number(strategyId)])
}

export async function getDefaultObserverSource() {
  return queryOne(`SELECT sources.id AS source_id, sources.bridge_user_id,
      sources.trading_account_id, sources.strategy_id, sources.name AS source_name,
      channels.id AS channel_id, channels.name AS channel_name, channels.slug AS channel_slug,
      strategies.symbols_json
    FROM ai_observer_channels channels
    JOIN ai_observer_sources sources ON sources.id = channels.source_id
    JOIN auto_prompt_types strategies ON strategies.id = sources.strategy_id
    WHERE channels.is_default = 1 AND channels.status = 'active' AND sources.status = 'active'
    ORDER BY channels.updated_at DESC, channels.id DESC LIMIT 1`)
}

export function observerSourceSupportsSymbol(source, symbol) {
  const requested = stripBrokerSuffix(String(symbol || '').trim())
  if (!requested) return false
  let symbols = []
  try { symbols = JSON.parse(source?.symbols_json || '[]') } catch {}
  return Array.isArray(symbols) && symbols.some(value => {
    const candidate = stripBrokerSuffix(String(value || '').trim())
    return candidate === requested
  })
}

export async function listObserverChannelsForUser(userId, plan = 'free') {
  const viewerId = Number(userId)
  const normalizedPlan = String(plan || 'free').toLowerCase()
  const cacheKey = `${viewerId}:${normalizedPlan}`
  const cached = viewerChannelCache.get(cacheKey)
  if (cached && cached.expires_at > Date.now()) return cached.channels
  const channels = await queryAll(`SELECT channels.id, channels.name, channels.slug,
      channels.description, channels.is_default, channels.sort_order,
      sources.id AS source_id, sources.name AS source_name,
      sources.bridge_user_id, sources.trading_account_id, sources.strategy_id
    FROM ai_observer_channels channels
    JOIN ai_observer_sources sources ON sources.id = channels.source_id
    WHERE channels.status = 'active' AND sources.status = 'active'
      AND (channels.audience = 'all' OR channels.audience = ? OR EXISTS (
        SELECT 1 FROM ai_observer_channel_assignments assignments
        WHERE assignments.channel_id = channels.id AND assignments.user_id = ?
      ))
    ORDER BY channels.is_default DESC, channels.sort_order, channels.id`, [normalizedPlan, viewerId])
  viewerChannelCache.set(cacheKey, { expires_at:Date.now() + VIEWER_CHANNEL_CACHE_MS, channels })
  return channels
}

export async function resolveObserverSourceForUser(userId, plan, requestedChannelId = null) {
  const channels = await listObserverChannelsForUser(userId, plan)
  if (!channels.length) return null
  if (requestedChannelId !== null && requestedChannelId !== undefined && requestedChannelId !== '') {
    const requestedId = Number(requestedChannelId)
    const selected = channels.find(channel => Number(channel.id) === requestedId)
    if (!selected) throw new Error('observer_channel_access_denied')
    return selected
  }
  return channels.find(channel => Number(channel.is_default) === 1) || channels[0]
}

export async function listObserverSources() {
  return queryAll(`SELECT sources.id, sources.name, sources.bridge_user_id,
      sources.trading_account_id, sources.strategy_id, sources.status, sources.notes,
      sources.created_by_user_id, sources.created_at, sources.updated_at,
      users.email AS bridge_user_email, users.nickname AS bridge_user_nickname,
      accounts.login_account, accounts.broker_server,
      strategies.title AS strategy_title,
      COALESCE(scheduler.enabled, 0) AS auto_inference_enabled,
      COALESCE(bridge_settings.trade_send_enabled, 0) AS trade_send_enabled,
      COUNT(channels.id) AS channel_count
    FROM ai_observer_sources sources
    JOIN users ON users.id = sources.bridge_user_id
    LEFT JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
    LEFT JOIN auto_prompt_types strategies ON strategies.id = sources.strategy_id
    LEFT JOIN auto_scheduler scheduler ON scheduler.user_id = sources.bridge_user_id
      AND scheduler.prompt_type_id = sources.strategy_id
    LEFT JOIN user_bridge_settings bridge_settings ON bridge_settings.user_id = sources.bridge_user_id
    LEFT JOIN ai_observer_channels channels ON channels.source_id = sources.id
    GROUP BY sources.id, sources.name, sources.bridge_user_id, sources.trading_account_id,
      sources.strategy_id, sources.status, sources.notes, sources.created_by_user_id, sources.created_at,
      sources.updated_at, users.email, users.nickname, accounts.login_account, accounts.broker_server, strategies.title,
      scheduler.enabled, bridge_settings.trade_send_enabled
    ORDER BY sources.status = 'active' DESC, sources.id`)
}

export async function createObserverSource(actorId, input = {}) {
  const bridgeUser = await validateBridgeUser(input.bridge_user_id)
  const tradingAccountId = await validateTradingAccount(input.trading_account_id, bridgeUser.id)
  const strategyId = await validatePlatformStrategy(input.strategy_id)
  const status = normalizedStatus(input.status, SOURCE_STATUSES)
  const runtime = {
    auto_inference_enabled: normalizedBoolean(input.auto_inference_enabled, true),
    trade_send_enabled: normalizedBoolean(input.trade_send_enabled, true),
  }
  const sourceId = await withTransaction(async run => {
    const db = transactionAdapter(run)
    const result = await db.execute(`INSERT INTO ai_observer_sources
      (name, bridge_user_id, trading_account_id, strategy_id, status, notes, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`, [
      requiredText(input.name, 'source_name_required', 80), bridgeUser.id, tradingAccountId, strategyId,
      status, optionalText(input.notes, 255), Number(actorId),
    ])
    if (status === 'active') await syncObserverSourceRuntime(bridgeUser.id, tradingAccountId, strategyId, runtime, db)
    return result.insertId
  })
  invalidateObserverChannelCache()
  return { ...await queryOne('SELECT * FROM ai_observer_sources WHERE id = ?', [sourceId]), ...runtime }
}

export async function updateObserverSource(id, input = {}) {
  const existing = await queryOne('SELECT * FROM ai_observer_sources WHERE id = ?', [Number(id)])
  if (!existing) throw new Error('observer_source_not_found')
  const bridgeUser = await validateBridgeUser(input.bridge_user_id ?? existing.bridge_user_id)
  const tradingAccountId = await validateTradingAccount(
    Object.prototype.hasOwnProperty.call(input, 'trading_account_id') ? input.trading_account_id : existing.trading_account_id,
    bridgeUser.id,
  )
  const strategyId = await validatePlatformStrategy(input.strategy_id ?? existing.strategy_id, Number(id))
  const status = input.status === undefined ? existing.status : normalizedStatus(input.status, SOURCE_STATUSES)
  const currentRuntime = await readObserverSourceRuntime(existing.bridge_user_id, existing.strategy_id)
  const runtime = {
    auto_inference_enabled: normalizedBoolean(input.auto_inference_enabled, currentRuntime.auto_inference_enabled),
    trade_send_enabled: normalizedBoolean(input.trade_send_enabled, currentRuntime.trade_send_enabled),
  }
  const runtimeChanged = Number(existing.bridge_user_id) !== Number(bridgeUser.id)
    || Number(existing.strategy_id) !== Number(strategyId)
    || existing.status !== status
  await withTransaction(async run => {
    const db = transactionAdapter(run)
    if (runtimeChanged && existing.strategy_id) {
      await disableObserverSourceRuntime(existing.bridge_user_id, existing.strategy_id, db)
    }
    await db.execute(`UPDATE ai_observer_sources SET name = ?, bridge_user_id = ?,
      trading_account_id = ?, strategy_id = ?, status = ?, notes = ?, updated_at = NOW() WHERE id = ?`, [
      input.name === undefined ? existing.name : requiredText(input.name, 'source_name_required', 80),
      bridgeUser.id, tradingAccountId, strategyId,
      status,
      input.notes === undefined ? existing.notes : optionalText(input.notes, 255), Number(id),
    ])
    if (status === 'active') await syncObserverSourceRuntime(bridgeUser.id, tradingAccountId, strategyId, runtime, db)
  })
  invalidateObserverChannelCache()
  return { ...await queryOne('SELECT * FROM ai_observer_sources WHERE id = ?', [Number(id)]), ...runtime }
}

export async function deleteObserverSource(id) {
  const sourceId = Number(id)
  const existing = await queryOne('SELECT id, bridge_user_id, strategy_id FROM ai_observer_sources WHERE id = ?', [sourceId])
  if (!existing) throw new Error('observer_source_not_found')
  const usage = await queryOne('SELECT COUNT(*) AS count FROM ai_observer_channels WHERE source_id = ?', [sourceId])
  if (Number(usage?.count || 0) > 0) throw new Error('observer_source_has_channels')
  await withTransaction(async run => {
    const db = transactionAdapter(run)
    if (existing.strategy_id) await disableObserverSourceRuntime(existing.bridge_user_id, existing.strategy_id, db)
    await db.execute('DELETE FROM ai_observer_sources WHERE id = ?', [sourceId])
  })
  invalidateObserverChannelCache()
  return {
    id:sourceId,
    bridge_user_id:Number(existing.bridge_user_id),
    strategy_id:Number(existing.strategy_id) || null,
  }
}

export async function listObserverChannels() {
  return queryAll(`SELECT channels.*, sources.name AS source_name,
      sources.bridge_user_id, sources.trading_account_id, sources.status AS source_status
    FROM ai_observer_channels channels
    JOIN ai_observer_sources sources ON sources.id = channels.source_id
    ORDER BY channels.is_default DESC, channels.sort_order, channels.id`)
}

async function validateSource(sourceId) {
  const id = Number(sourceId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_observer_source_id')
  const source = await queryOne('SELECT id FROM ai_observer_sources WHERE id = ?', [id])
  if (!source) throw new Error('observer_source_not_found')
  return id
}

async function setOnlyDefault(run, channelId) {
  await run('UPDATE ai_observer_channels SET is_default = 0 WHERE is_default = 1')
  await run('UPDATE ai_observer_channels SET is_default = 1, updated_at = NOW() WHERE id = ?', [channelId])
}

export async function createObserverChannel(input = {}) {
  const sourceId = await validateSource(input.source_id)
  const audience = String(input.audience || 'all').toLowerCase()
  if (!CHANNEL_AUDIENCES.has(audience)) throw new Error('invalid_channel_audience')
  const channel = await withTransaction(async run => {
    const [result] = await run(`INSERT INTO ai_observer_channels
      (name, slug, description, source_id, audience, status, is_default, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, NOW(), NOW())`, [
      requiredText(input.name, 'channel_name_required', 80), normalizedSlug(input.slug),
      optionalText(input.description, 255), sourceId, audience,
      normalizedStatus(input.status, CHANNEL_STATUSES), Math.max(0, Math.trunc(Number(input.sort_order) || 0)),
    ])
    const [[countRow]] = await run('SELECT COUNT(*) AS count FROM ai_observer_channels WHERE is_default = 1')
    if (input.is_default === true || Number(countRow?.count || 0) === 0) await setOnlyDefault(run, result.insertId)
    const [[channel]] = await run('SELECT * FROM ai_observer_channels WHERE id = ?', [result.insertId])
    return channel
  })
  invalidateObserverChannelCache()
  return channel
}

export async function updateObserverChannel(id, input = {}) {
  const channelId = Number(id)
  const existing = await queryOne('SELECT * FROM ai_observer_channels WHERE id = ?', [channelId])
  if (!existing) throw new Error('observer_channel_not_found')
  const sourceId = await validateSource(input.source_id ?? existing.source_id)
  const audience = String(input.audience ?? existing.audience).toLowerCase()
  if (!CHANNEL_AUDIENCES.has(audience)) throw new Error('invalid_channel_audience')
  const channel = await withTransaction(async run => {
    await run(`UPDATE ai_observer_channels SET name = ?, slug = ?, description = ?,
      source_id = ?, audience = ?, status = ?, sort_order = ?, updated_at = NOW() WHERE id = ?`, [
      input.name === undefined ? existing.name : requiredText(input.name, 'channel_name_required', 80),
      input.slug === undefined ? existing.slug : normalizedSlug(input.slug),
      input.description === undefined ? existing.description : optionalText(input.description, 255),
      sourceId, audience,
      input.status === undefined ? existing.status : normalizedStatus(input.status, CHANNEL_STATUSES),
      input.sort_order === undefined ? existing.sort_order : Math.max(0, Math.trunc(Number(input.sort_order) || 0)),
      channelId,
    ])
    if (input.is_default === true) await setOnlyDefault(run, channelId)
    const [[channel]] = await run('SELECT * FROM ai_observer_channels WHERE id = ?', [channelId])
    return channel
  })
  invalidateObserverChannelCache()
  return channel
}

export async function deleteObserverChannel(id) {
  const channelId = Number(id)
  const existing = await queryOne('SELECT id, is_default FROM ai_observer_channels WHERE id = ?', [channelId])
  if (!existing) throw new Error('observer_channel_not_found')
  if (Number(existing.is_default) === 1) throw new Error('default_observer_channel_cannot_be_deleted')
  await queryRun('DELETE FROM ai_observer_channels WHERE id = ?', [channelId])
  invalidateObserverChannelCache()
  return { id: channelId }
}

export async function listObserverChannelAssignments(channelId) {
  const id = Number(channelId)
  const channel = await queryOne('SELECT id FROM ai_observer_channels WHERE id = ?', [id])
  if (!channel) throw new Error('observer_channel_not_found')
  return queryAll(`SELECT assignments.user_id, assignments.created_at,
      users.email, users.nickname, users.plan
    FROM ai_observer_channel_assignments assignments
    JOIN users ON users.id = assignments.user_id
    WHERE assignments.channel_id = ? ORDER BY users.id`, [id])
}

export async function replaceObserverChannelAssignments(channelId, actorId, userIds = []) {
  const id = Number(channelId)
  const channel = await queryOne('SELECT id FROM ai_observer_channels WHERE id = ?', [id])
  if (!channel) throw new Error('observer_channel_not_found')
  const normalizedIds = [...new Set((Array.isArray(userIds) ? userIds : [])
    .map(Number).filter(userId => Number.isInteger(userId) && userId > 0))]
  if (normalizedIds.length) {
    const users = await queryAll(`SELECT id FROM users WHERE deletion_status = 'active'
      AND deleted_at IS NULL AND id IN (${normalizedIds.map(() => '?').join(',')})`, normalizedIds)
    if (users.length !== normalizedIds.length) throw new Error('observer_assignment_user_not_found')
  }
  await withTransaction(async run => {
    await run('DELETE FROM ai_observer_channel_assignments WHERE channel_id = ?', [id])
    for (const userId of normalizedIds) {
      await run(`INSERT INTO ai_observer_channel_assignments
        (channel_id, user_id, created_by_user_id, created_at) VALUES (?, ?, ?, NOW())`,
      [id, userId, Number(actorId)])
    }
  })
  invalidateObserverChannelCache()
  return listObserverChannelAssignments(id)
}
