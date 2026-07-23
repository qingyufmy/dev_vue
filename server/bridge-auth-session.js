import crypto from 'crypto'
import { queryOne, queryRun } from './db.js'
import { BRIDGE_REFRESH_TTL_DAYS } from './config.js'
import { hasActiveMembership } from './membership.js'

const hashToken = token => crypto.createHash('sha256').update(String(token || '')).digest('hex')

function assertBridgeEligible(user) {
  if (!user || (user.role !== 'admin' && !hasActiveMembership(user, 'pro'))) {
    const error = new Error('bridge_membership_required')
    error.code = 'bridge_membership_required'
    throw error
  }
}

export async function createBridgeRefreshSession(user, { userAgent = '', ip = '' } = {}) {
  assertBridgeEligible(user)
  const refreshToken = crypto.randomBytes(48).toString('base64url')
  await queryRun(`INSERT INTO bridge_refresh_sessions
    (user_id, token_hash, expires_at, last_used_at, user_agent, last_ip, created_at, updated_at)
    VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), NOW(), ?, ?, NOW(), NOW())`, [
    user.id, hashToken(refreshToken), BRIDGE_REFRESH_TTL_DAYS,
    String(userAgent || '').slice(0, 255), String(ip || '').slice(0, 64),
  ])
  await queryRun(`DELETE FROM bridge_refresh_sessions
    WHERE user_id = ? AND (expires_at <= NOW() OR revoked_at IS NOT NULL)`, [user.id])
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
      AND sessions.expires_at > NOW()
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL`, [hashToken(refreshToken)])
  if (!session) {
    const error = new Error('bridge_refresh_expired')
    error.code = 'bridge_refresh_expired'
    throw error
  }
  assertBridgeEligible(session)
  await queryRun(`UPDATE bridge_refresh_sessions
    SET expires_at = DATE_ADD(NOW(), INTERVAL ? DAY), last_used_at = NOW(),
      user_agent = ?, last_ip = ?, updated_at = NOW()
    WHERE id = ?`, [
    BRIDGE_REFRESH_TTL_DAYS, String(userAgent || '').slice(0, 255),
    String(ip || '').slice(0, 64), session.session_id,
  ])
  return { user: session, expiresInSeconds: BRIDGE_REFRESH_TTL_DAYS * 86400 }
}

export async function revokeBridgeRefreshSessions(userId) {
  if (!userId) return
  await queryRun(`UPDATE bridge_refresh_sessions
    SET revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
    WHERE user_id = ? AND revoked_at IS NULL`, [userId])
}
