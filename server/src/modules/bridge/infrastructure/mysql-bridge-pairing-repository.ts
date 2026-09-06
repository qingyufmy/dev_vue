import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { BridgePairingError, type BridgePairingRepository, type PairingReceipt } from '../application/bridge-pairing-service.js'

interface PairRow extends RowDataPacket {
  id: string; user_id: number; code_hash: string; profile_id: string
  installation_id: string | null; refresh_session_id: number | null; consumed_at_utc: string | null
  expires_at: string; unexpired: number
  revoked_at_utc: string | null
}

export class MysqlBridgePairingRepository implements BridgePairingRepository {
  constructor(private readonly pool: Pool) {}

  async create(userId: number, requestKey: string, codeHash: string) {
    return this.transaction(async connection => {
      await lockEligibleUser(connection, userId)
      const [existing] = await connection.execute<PairRow[]>(`${PAIR_SELECT}
        WHERE user_id=? AND request_key=? FOR UPDATE`, [userId, requestKey])
      if (existing[0]) {
        if (existing[0].code_hash !== codeHash) throw new BridgePairingError('bridge_pairing_request_conflict', 409)
        assertUnexpired(existing[0])
        return receipt(existing[0])
      }
      const [counts] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count
        FROM bridge_v4_pairing_requests WHERE user_id=? AND created_at_utc > UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE`, [userId])
      if (Number(counts[0]?.count) >= 10) throw new BridgePairingError('bridge_pairing_rate_limited', 429)
      const id = randomUUID()
      const profileId = `profile-${randomUUID()}`
      await connection.execute(`INSERT INTO bridge_v4_pairing_requests
        (id,user_id,request_key,code_hash,profile_id,created_at_utc,expires_at_utc)
        VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3) + INTERVAL 10 MINUTE)`, [id, userId, requestKey, codeHash, profileId])
      const [created] = await connection.execute<PairRow[]>(`${PAIR_SELECT} WHERE id=?`, [id])
      if (!created[0]) throw new BridgePairingError('bridge_pairing_storage_failed', 503)
      return receipt(created[0])
    })
  }

  async redeem(codeHash: string, installationId: string, tokenHash: string) {
    // The lookup is not an authorization decision. Lock the user first, then
    // reread/lock the request, so create and redeem share a transaction order.
    const [owners] = await this.pool.execute<RowDataPacket[]>(
      'SELECT user_id FROM bridge_v4_pairing_requests WHERE code_hash=?', [codeHash])
    if (!owners[0]) throw new BridgePairingError('bridge_pairing_invalid', 401)
    const userId = Number(owners[0].user_id)
    return this.transaction(async connection => {
      await lockEligibleUser(connection, userId)
      const [rows] = await connection.execute<PairRow[]>(`${PAIR_SELECT}
        WHERE user_id=? AND code_hash=? FOR UPDATE`, [userId, codeHash])
      const pair = rows[0]
      if (!pair) throw new BridgePairingError('bridge_pairing_invalid', 401)
      assertUnexpired(pair)
      if (pair.consumed_at_utc) {
        const [credentials] = await connection.execute<RowDataPacket[]>(`SELECT generation
          FROM bridge_refresh_sessions WHERE id=? AND user_id=? AND credential_version=4
          AND installation_id=? AND profile_id=? AND token_hash=? AND revoked_at IS NULL FOR UPDATE`,
        [pair.refresh_session_id, userId, installationId, pair.profile_id, tokenHash])
        if (pair.installation_id !== installationId || !credentials[0]) {
          throw new BridgePairingError('bridge_pairing_already_used', 409)
        }
        return { profileId: pair.profile_id, installationId, generation: Number(credentials[0].generation) }
      }
      // A pairing allocates a fresh profile identity; it cannot rotate or take
      // over an existing profile, even if a legacy identifier happens to match.
      const [profiles] = await connection.execute<RowDataPacket[]>('SELECT id FROM terminal_profiles WHERE id=? FOR UPDATE', [pair.profile_id])
      const [sessions] = await connection.execute<RowDataPacket[]>('SELECT id FROM bridge_refresh_sessions WHERE user_id=? AND profile_id=? LIMIT 1 FOR UPDATE', [userId, pair.profile_id])
      if (profiles.length || sessions.length) throw new BridgePairingError('bridge_pairing_profile_conflict', 409)
      const [created] = await connection.execute<ResultSetHeader>(`INSERT INTO bridge_refresh_sessions
        (user_id,token_hash,expires_at,created_at,updated_at,credential_version,installation_id,profile_id,generation)
        VALUES (?,?,'9999-12-31 23:59:59',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),4,?,?,1)`,
      [userId, tokenHash, installationId, pair.profile_id])
      await connection.execute(`UPDATE bridge_v4_pairing_requests
        SET installation_id=?,refresh_session_id=?,consumed_at_utc=UTC_TIMESTAMP(3) WHERE id=?`,
      [installationId, created.insertId, pair.id])
      return { profileId: pair.profile_id, installationId, generation: 1 }
    })
  }

  private async transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const result = await work(connection)
      await connection.commit()
      return result
    } catch (error) {
      await connection.rollback()
      if (error instanceof BridgePairingError) throw error
      throw new BridgePairingError('bridge_pairing_storage_failed', 503)
    } finally { connection.release() }
  }
}

const PAIR_SELECT = `SELECT id,user_id,code_hash,profile_id,installation_id,refresh_session_id,consumed_at_utc,revoked_at_utc,
  DATE_FORMAT(expires_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
  (expires_at_utc > UTC_TIMESTAMP(3)) AS unexpired FROM bridge_v4_pairing_requests`

async function lockEligibleUser(connection: PoolConnection, userId: number) {
  const [users] = await connection.execute<RowDataPacket[]>(`SELECT id FROM users WHERE id=?
    AND deletion_status='active' AND deleted_at IS NULL
    AND (role='admin' OR (plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at > UTC_TIMESTAMP(3)))) FOR UPDATE`, [userId])
  if (!users[0]) throw new BridgePairingError('bridge_pairing_not_eligible', 403)
}

function assertUnexpired(row: PairRow) {
  if (row.revoked_at_utc) throw new BridgePairingError('bridge_pairing_revoked', 401)
  if (!Number(row.unexpired)) throw new BridgePairingError('bridge_pairing_expired', 410)
}
function receipt(row: PairRow): PairingReceipt {
  return { pairingId: row.id, profileId: row.profile_id, expiresAt: row.expires_at }
}
