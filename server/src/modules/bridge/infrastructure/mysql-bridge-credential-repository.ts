import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { BridgeCredentialError } from '../domain/bridge-credential.js'
import type {
  BridgeCredentialRepository,
  DeviceRefreshSession,
  RotateLegacyCredentialInput,
  RotatedBridgeCredential,
  UseDeviceRefreshInput,
} from '../application/bridge-credential-ports.js'

interface LegacySessionRow extends RowDataPacket {
  session_id: number
  user_id: number
  role: string
  plan: string | null
  plan_expires_at: string | null
}

interface DeviceSessionRow extends RowDataPacket {
  session_id: number
  user_id: number
  installation_id: string
  profile_id: string
  generation: number
  revoked_at: string | null
  migration_key: string
}

function isEligible(row: LegacySessionRow): boolean {
  if (String(row.role).toLowerCase() === 'admin') return true
  return row.plan === 'pro'
}

async function inTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export class MysqlBridgeCredentialRepository implements BridgeCredentialRepository {
  constructor(private readonly pool: Pool) {}

  async revokeDeviceRefresh(input: Pick<UseDeviceRefreshInput, 'tokenHash' | 'installationId' | 'profileId'>): Promise<DeviceRefreshSession> {
    try {
      return await inTransaction(this.pool, async connection => {
        // This operation locks only the exact credential. It never takes account,
        // owner or user locks and cannot invert gateway authorization's lock order.
        const [rows] = await connection.execute<DeviceSessionRow[]>(`SELECT id AS session_id,user_id,installation_id,profile_id,generation,revoked_at
          FROM bridge_refresh_sessions
          WHERE token_hash=? AND credential_version=4 AND installation_id=? AND profile_id=?
          FOR UPDATE`, [input.tokenHash, input.installationId, input.profileId])
        const session = rows[0]
        if (rows.length !== 1 || !session) throw new BridgeCredentialError('bridge_credential_binding_invalid', 401)
        if (!Number.isSafeInteger(session.generation) || session.generation < 1) {
          throw new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
        }
        if (session.revoked_at === null) {
          const [updated] = await connection.execute<ResultSetHeader>(`UPDATE bridge_refresh_sessions
            SET revoked_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3)
            WHERE id=? AND token_hash=? AND credential_version=4 AND installation_id=? AND profile_id=?
              AND generation=? AND revoked_at IS NULL`,
          [session.session_id, input.tokenHash, input.installationId, input.profileId, session.generation])
          if (updated.affectedRows !== 1) throw new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
        }
        return { userId: session.user_id, installationId: session.installation_id, profileId: session.profile_id, generation: session.generation }
      })
    } catch (error) {
      if (error instanceof BridgeCredentialError) throw error
      throw new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
    }
  }

  async rotateFromLegacy(input: RotateLegacyCredentialInput): Promise<RotatedBridgeCredential> {
    return inTransaction(this.pool, async connection => {
      const [legacyRows] = await connection.execute<LegacySessionRow[]>(`
        SELECT s.id AS session_id, s.user_id, u.role, u.plan, u.plan_expires_at
        FROM bridge_refresh_sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
          AND s.credential_version = 3
          AND s.revoked_at IS NULL
          AND u.deletion_status = 'active'
          AND u.deleted_at IS NULL
          AND (u.role = 'admin' OR u.plan_expires_at IS NULL OR u.plan_expires_at > UTC_TIMESTAMP(3))
        FOR UPDATE`, [input.legacyTokenHash])
      const legacy = legacyRows[0]
      if (!legacy || !isEligible(legacy)) {
        throw new BridgeCredentialError('bridge_legacy_credential_invalid', 401)
      }

      const [existingRows] = await connection.execute<DeviceSessionRow[]>(`
        SELECT id AS session_id, user_id, installation_id, profile_id, generation, revoked_at,
               migration_key
        FROM bridge_refresh_sessions
        WHERE credential_version = 4 AND source_refresh_session_id = ?
        FOR UPDATE`, [legacy.session_id])
      const existing = existingRows[0]
      if (existing && String(existing.migration_key) !== input.migrationKey) {
        throw new BridgeCredentialError('bridge_credential_migration_conflict', 409)
      }
      if (existing?.revoked_at) {
        throw new BridgeCredentialError('bridge_credential_migration_revoked', 409)
      }

      if (existing) {
        await connection.execute(`
          UPDATE bridge_refresh_sessions
          SET token_hash = ?, expires_at = '9999-12-31 23:59:59',
              generation = generation + 1, last_used_at = UTC_TIMESTAMP(3),
              user_agent = ?, last_ip = ?, updated_at = UTC_TIMESTAMP(3)
          WHERE id = ?`, [
          input.replacementTokenHash,
          input.userAgent,
          input.ipAddress,
          existing.session_id,
        ])
        return { userId: existing.user_id, generation: existing.generation + 1 }
      }

      const [result] = await connection.execute(`
        INSERT INTO bridge_refresh_sessions
          (user_id, token_hash, expires_at, last_used_at, user_agent, last_ip,
           created_at, updated_at, credential_version, installation_id, profile_id,
           generation, migration_key, source_fingerprint, source_refresh_session_id)
        VALUES (?, ?, '9999-12-31 23:59:59', UTC_TIMESTAMP(3), ?, ?,
                UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 4, ?, ?, 1, ?, ?, ?)`, [
        legacy.user_id,
        input.replacementTokenHash,
        input.userAgent,
        input.ipAddress,
        input.installationId,
        input.profileId,
        input.migrationKey,
        input.sourceFingerprint,
        legacy.session_id,
      ])
      if (!('insertId' in result) || !result.insertId) {
        throw new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
      }
      return { userId: legacy.user_id, generation: 1 }
    })
  }

  async useDeviceRefresh(input: UseDeviceRefreshInput): Promise<DeviceRefreshSession> {
    return inTransaction(this.pool, async connection => {
      const [rows] = await connection.execute<(LegacySessionRow & DeviceSessionRow)[]>(`
        SELECT s.id AS session_id, s.user_id, s.installation_id, s.profile_id,
               s.generation, s.revoked_at, u.role, u.plan, u.plan_expires_at
        FROM bridge_refresh_sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
          AND s.credential_version = 4
          AND s.installation_id = ?
          AND s.profile_id = ?
          AND s.revoked_at IS NULL
          AND u.deletion_status = 'active'
          AND u.deleted_at IS NULL
          AND (u.role = 'admin' OR u.plan_expires_at IS NULL OR u.plan_expires_at > UTC_TIMESTAMP(3))
        FOR UPDATE`, [input.tokenHash, input.installationId, input.profileId])
      const session = rows[0]
      if (!session || !isEligible(session)) {
        throw new BridgeCredentialError('bridge_credential_binding_invalid', 401)
      }
      await connection.execute(`
        UPDATE bridge_refresh_sessions
        SET last_used_at = UTC_TIMESTAMP(3), user_agent = ?, last_ip = ?, updated_at = UTC_TIMESTAMP(3)
        WHERE id = ?`, [input.userAgent, input.ipAddress, session.session_id])
      return {
        userId: session.user_id,
        installationId: session.installation_id,
        profileId: session.profile_id,
        generation: session.generation,
      }
    })
  }
}
