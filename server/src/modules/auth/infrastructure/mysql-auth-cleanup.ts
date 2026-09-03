import type { Pool } from 'mysql2/promise'

export interface AuthCleanupResult {
  authorizationCodesDeleted: number
  sessionsDeleted: number
}

function affectedRows(result: unknown) {
  return typeof result === 'object' && result !== null && 'affectedRows' in result
    ? Number(result.affectedRows)
    : 0
}

export async function cleanupExpiredAuthRecords(pool: Pool, batchSize = 1000): Promise<AuthCleanupResult> {
  const boundedBatch = Math.max(1, Math.min(5000, Math.trunc(batchSize)))
  const [codeResult] = await pool.execute(`
    DELETE FROM auth_authorization_codes
    WHERE expires_at_utc < UTC_TIMESTAMP(3) - INTERVAL 1 DAY
    ORDER BY id
    LIMIT ${boundedBatch}`)
  const [sessionResult] = await pool.execute(`
    DELETE FROM auth_sessions
    WHERE id IN (
      SELECT id FROM (
        SELECT s.id
        FROM auth_sessions s
        LEFT JOIN auth_authorization_codes c ON c.auth_session_id = s.id
        LEFT JOIN auth_sessions child ON child.parent_session_id = s.id
        WHERE c.id IS NULL AND child.id IS NULL
          AND (s.absolute_expires_at_utc < UTC_TIMESTAMP(3) - INTERVAL 30 DAY
            OR s.revoked_at_utc < UTC_TIMESTAMP(3) - INTERVAL 30 DAY)
        ORDER BY s.id
        LIMIT ${boundedBatch}
      ) expired_sessions
    )`)
  return {
    authorizationCodesDeleted: affectedRows(codeResult),
    sessionsDeleted: affectedRows(sessionResult),
  }
}
