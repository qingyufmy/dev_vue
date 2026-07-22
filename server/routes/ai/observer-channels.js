import { queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

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

function normalizedSlug(value) {
  const slug = requiredText(value, 'channel_slug_required', 64).toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error('invalid_channel_slug')
  return slug
}

async function validateBridgeUser(bridgeUserId) {
  const id = Number(bridgeUserId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_bridge_user_id')
  const user = await queryOne(`SELECT id, role, email, nickname FROM users
    WHERE id = ? AND deletion_status = 'active' AND deleted_at IS NULL`, [id])
  if (!user) throw new Error('bridge_user_not_found')
  // Phase 1 keeps the current JWT bridge authentication intact. Dedicated
  // non-login source credentials are introduced with the bridge manager.
  if (String(user.role || '').toLowerCase() !== 'admin') throw new Error('bridge_user_must_be_admin')
  return user
}

async function validateTradingAccount(tradingAccountId, bridgeUserId) {
  if (tradingAccountId === undefined || tradingAccountId === null || tradingAccountId === '') return null
  const id = Number(tradingAccountId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_trading_account_id')
  const account = await queryOne(`SELECT id FROM trading_accounts
    WHERE id = ? AND user_id = ? AND is_deleted = 0`, [id, bridgeUserId])
  if (!account) throw new Error('trading_account_not_owned_by_source')
  return id
}

export async function getDefaultObserverSource() {
  return queryOne(`SELECT sources.id AS source_id, sources.bridge_user_id,
      sources.trading_account_id, sources.name AS source_name,
      channels.id AS channel_id, channels.name AS channel_name, channels.slug AS channel_slug
    FROM ai_observer_channels channels
    JOIN ai_observer_sources sources ON sources.id = channels.source_id
    WHERE channels.is_default = 1 AND channels.status = 'active' AND sources.status = 'active'
    ORDER BY channels.updated_at DESC, channels.id DESC LIMIT 1`)
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
      sources.bridge_user_id, sources.trading_account_id
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
      sources.trading_account_id, sources.status, sources.notes,
      sources.created_by_user_id, sources.created_at, sources.updated_at,
      users.email AS bridge_user_email, users.nickname AS bridge_user_nickname,
      accounts.login_account, accounts.broker_server,
      COUNT(channels.id) AS channel_count
    FROM ai_observer_sources sources
    JOIN users ON users.id = sources.bridge_user_id
    LEFT JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
    LEFT JOIN ai_observer_channels channels ON channels.source_id = sources.id
    GROUP BY sources.id, sources.name, sources.bridge_user_id, sources.trading_account_id,
      sources.status, sources.notes, sources.created_by_user_id, sources.created_at,
      sources.updated_at, users.email, users.nickname, accounts.login_account, accounts.broker_server
    ORDER BY sources.status = 'active' DESC, sources.id`)
}

export async function createObserverSource(actorId, input = {}) {
  const bridgeUser = await validateBridgeUser(input.bridge_user_id)
  const tradingAccountId = await validateTradingAccount(input.trading_account_id, bridgeUser.id)
  const result = await queryRun(`INSERT INTO ai_observer_sources
    (name, bridge_user_id, trading_account_id, status, notes, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`, [
    requiredText(input.name, 'source_name_required', 80), bridgeUser.id, tradingAccountId,
    normalizedStatus(input.status, SOURCE_STATUSES), optionalText(input.notes, 255), Number(actorId),
  ])
  invalidateObserverChannelCache()
  return queryOne('SELECT * FROM ai_observer_sources WHERE id = ?', [result.insertId])
}

export async function updateObserverSource(id, input = {}) {
  const existing = await queryOne('SELECT * FROM ai_observer_sources WHERE id = ?', [Number(id)])
  if (!existing) throw new Error('observer_source_not_found')
  const bridgeUser = await validateBridgeUser(input.bridge_user_id ?? existing.bridge_user_id)
  const tradingAccountId = await validateTradingAccount(
    Object.prototype.hasOwnProperty.call(input, 'trading_account_id') ? input.trading_account_id : existing.trading_account_id,
    bridgeUser.id,
  )
  await queryRun(`UPDATE ai_observer_sources SET name = ?, bridge_user_id = ?,
    trading_account_id = ?, status = ?, notes = ?, updated_at = NOW() WHERE id = ?`, [
    input.name === undefined ? existing.name : requiredText(input.name, 'source_name_required', 80),
    bridgeUser.id, tradingAccountId,
    input.status === undefined ? existing.status : normalizedStatus(input.status, SOURCE_STATUSES),
    input.notes === undefined ? existing.notes : optionalText(input.notes, 255), Number(id),
  ])
  invalidateObserverChannelCache()
  return queryOne('SELECT * FROM ai_observer_sources WHERE id = ?', [Number(id)])
}

export async function deleteObserverSource(id) {
  const sourceId = Number(id)
  const existing = await queryOne('SELECT id FROM ai_observer_sources WHERE id = ?', [sourceId])
  if (!existing) throw new Error('observer_source_not_found')
  const usage = await queryOne('SELECT COUNT(*) AS count FROM ai_observer_channels WHERE source_id = ?', [sourceId])
  if (Number(usage?.count || 0) > 0) throw new Error('observer_source_has_channels')
  await queryRun('DELETE FROM ai_observer_sources WHERE id = ?', [sourceId])
  invalidateObserverChannelCache()
  return { id: sourceId }
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
