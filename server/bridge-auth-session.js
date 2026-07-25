import crypto from 'crypto'
import { queryOne, queryRun } from './db.js'
import { BRIDGE_REFRESH_TTL_DAYS } from './config.js'
import { hasActiveMembership } from './membership.js'
import { getRedis, isRedisAvailable } from './redis.js'

const hashToken = token => crypto.createHash('sha256').update(String(token || '')).digest('hex')
const BRIDGE_TICKET_TTL_SECONDS = 30
const bridgeTickets = new Map()
const CONSUME_TICKET_LUA = `
local value = redis.call("get", KEYS[1])
if value then redis.call("del", KEYS[1]) end
return value
`

function ticketKey(ticket) {
  return `bridge:ws-ticket:${hashToken(ticket)}`
}

function removeExpiredMemoryTickets(now = Date.now()) {
  for (const [key, entry] of bridgeTickets) {
    if (!entry || entry.expiresAt <= now) bridgeTickets.delete(key)
  }
}

export function assertBridgeEligible(user) {
  if (!user || (user.role !== 'admin' && !hasActiveMembership(user, 'pro'))) {
    const error = new Error('bridge_membership_required')
    error.code = 'bridge_membership_required'
    throw error
  }
}

export async function createBridgeRefreshSession(user, { userAgent = '', ip = '', run } = {}) {
  assertBridgeEligible(user)
  const execute = run || queryRun
  const refreshToken = crypto.randomBytes(48).toString('base64url')
  await execute(`INSERT INTO bridge_refresh_sessions
    (user_id, token_hash, expires_at, last_used_at, user_agent, last_ip, created_at, updated_at)
    VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), NOW(), ?, ?, NOW(), NOW())`, [
    user.id, hashToken(refreshToken), BRIDGE_REFRESH_TTL_DAYS,
    String(userAgent || '').slice(0, 255), String(ip || '').slice(0, 64),
  ])
  await execute(`DELETE FROM bridge_refresh_sessions
    WHERE user_id = ? AND revoked_at IS NOT NULL`, [user.id])
  return { refreshToken, expiresInSeconds: BRIDGE_REFRESH_TTL_DAYS * 86400 }
}

export async function useBridgeRefreshSession(refreshToken, { userAgent = '', ip = '' } = {}) {
  if (!refreshToken || String(refreshToken).length < 40) {
    const error = new Error('bridge_refresh_invalid')
    error.code = 'bridge_refresh_invalid'
    throw error
  }
  const session = await queryOne(`SELECT sessions.id AS session_id, users.*,
      (users.plan IN ('pro', 'plus') AND users.plan_expires_at IS NOT NULL
        AND users.plan_expires_at < NOW()) AS membership_expired
    FROM bridge_refresh_sessions sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL`, [hashToken(refreshToken)])
  if (!session) {
    const error = new Error('bridge_refresh_revoked')
    error.code = 'bridge_refresh_revoked'
    throw error
  }
  assertBridgeEligible(session)
  await queryRun(`UPDATE bridge_refresh_sessions
    SET last_used_at = NOW(), user_agent = ?, last_ip = ?, updated_at = NOW()
    WHERE id = ?`, [
    String(userAgent || '').slice(0, 255), String(ip || '').slice(0, 64),
    session.session_id,
  ])
  return { user: session, expiresInSeconds: BRIDGE_REFRESH_TTL_DAYS * 86400 }
}

export async function revokeBridgeRefreshSessions(userId, { run } = {}) {
  if (!userId) return
  const execute = run || queryRun
  await execute(`UPDATE bridge_refresh_sessions
    SET revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
    WHERE user_id = ? AND revoked_at IS NULL`, [userId])
}

export async function revokeBridgeRefreshSession(userId, refreshToken, { run } = {}) {
  if (!userId || !refreshToken || String(refreshToken).length < 40) return false
  const execute = run || queryRun
  const result = await execute(`UPDATE bridge_refresh_sessions
    SET revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
    WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL`, [userId, hashToken(refreshToken)])
  return Number(result?.affectedRows ?? result?.changes ?? 0) === 1
}

export async function createBridgeConnectionTicket(user, { redis } = {}) {
  assertBridgeEligible(user)
  const ticket = crypto.randomBytes(32).toString('base64url')
  const payload = JSON.stringify({
    userId: Number(user.id),
    tokenVersion: Number(user.token_version || 0),
  })
  const selectedRedis = redis === undefined
    ? (isRedisAvailable() ? getRedis() : null)
    : redis
  if (selectedRedis) {
    const stored = await selectedRedis.set(ticketKey(ticket), payload, 'NX', 'EX', BRIDGE_TICKET_TTL_SECONDS)
    if (stored !== 'OK') {
      const error = new Error('bridge_ticket_storage_failed')
      error.code = 'bridge_ticket_storage_failed'
      throw error
    }
  } else {
    removeExpiredMemoryTickets()
    bridgeTickets.set(ticketKey(ticket), {
      payload,
      expiresAt: Date.now() + BRIDGE_TICKET_TTL_SECONDS * 1000,
    })
  }
  return { ticket, expiresInSeconds: BRIDGE_TICKET_TTL_SECONDS }
}

export async function consumeBridgeConnectionTicket(ticket, { redis } = {}) {
  if (!ticket || String(ticket).length < 40) {
    const error = new Error('bridge_ticket_invalid')
    error.code = 'bridge_ticket_invalid'
    throw error
  }
  const selectedRedis = redis === undefined
    ? (isRedisAvailable() ? getRedis() : null)
    : redis
  let raw = null
  if (selectedRedis) {
    raw = await selectedRedis.eval(CONSUME_TICKET_LUA, 1, ticketKey(ticket))
  } else {
    removeExpiredMemoryTickets()
    const key = ticketKey(ticket)
    const entry = bridgeTickets.get(key)
    bridgeTickets.delete(key)
    raw = entry?.payload || null
  }
  if (!raw) {
    const error = new Error('bridge_ticket_expired')
    error.code = 'bridge_ticket_expired'
    throw error
  }
  try {
    const payload = JSON.parse(raw)
    if (!Number.isInteger(payload.userId) || payload.userId <= 0) throw new Error('invalid_payload')
    return payload
  } catch {
    const error = new Error('bridge_ticket_invalid')
    error.code = 'bridge_ticket_invalid'
    throw error
  }
}
