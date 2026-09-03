import type { Pool } from 'mysql2/promise'
import type { BridgeDeviceRevoker } from '../application/auth-ports.js'

export class MysqlBridgeDeviceRevoker implements BridgeDeviceRevoker {
  constructor(private readonly pool: Pool) {}

  async revokeUserDevices(userId: number, reason: string, now: Date) {
    await this.pool.execute(`
      UPDATE bridge_refresh_sessions
      SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
      WHERE user_id = ? AND revoked_at IS NULL`, [now, now, userId])
    void reason
  }
}
