import type { Pool } from 'mysql2/promise'

export class MysqlBridgeDeviceRevoker {
  constructor(private readonly pool: Pool) {}

  async revokeUserDevices(userId: number, reason: string, now: Date) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [userId])
      await connection.execute(`UPDATE bridge_installation_authorizations SET revoked_at_utc=COALESCE(revoked_at_utc,?) WHERE user_id=?`, [now, userId])
      await connection.execute(`UPDATE bridge_installation_requests SET status='revoked',revision=revision+1 WHERE user_id=? AND status<>'revoked'`, [userId])
      await connection.execute(`UPDATE bridge_v4_pairing_requests
        SET revoked_at_utc=? WHERE user_id=? AND revoked_at_utc IS NULL`, [now, userId])
      await connection.execute(`UPDATE bridge_refresh_sessions
        SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE user_id = ? AND revoked_at IS NULL`, [now, now, userId])
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
    void reason
  }
}
