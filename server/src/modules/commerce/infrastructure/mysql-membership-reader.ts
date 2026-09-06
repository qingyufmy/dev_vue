import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { validateMembershipState, type MembershipState } from '../domain/membership.js'

interface MembershipRow extends RowDataPacket {
  user_id: string
  plan_code: MembershipState['planCode']
  billing_period_code: string | null
  source_code: string | null
  expiration_kind: MembershipState['expirationKind']
  expires_at_utc: string | null
  revision: string
}

// No legacy fallback: callers must gate cutover until every required membership
// has been migrated and reconciled. A missing row is not a free membership.
export async function readCurrentMembership(connection: Pick<PoolConnection, 'execute'>, userId: number): Promise<MembershipState | null> {
  if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2147483647) throw new Error('membership_user_invalid')
  const [rows] = await connection.execute<MembershipRow[]>(
    `SELECT CAST(user_id AS CHAR) user_id,plan_code,billing_period_code,source_code,expiration_kind,
       CONCAT(LEFT(DATE_FORMAT(expires_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') expires_at_utc,
       CAST(revision AS CHAR) revision
     FROM memberships WHERE user_id=?`, [userId])
  if (rows.length === 0) return null
  const row = rows[0]
  if (rows.length !== 1 || !row || row.user_id !== String(userId)) throw new Error('membership_read_identity_mismatch')
  const result: MembershipState = { userId, planCode: row.plan_code, billingPeriodCode: row.billing_period_code,
    sourceCode: row.source_code, expirationKind: row.expiration_kind, expiresAtUtc: row.expires_at_utc, revision: row.revision }
  validateMembershipState(result)
  return result
}
