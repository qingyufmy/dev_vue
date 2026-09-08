import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ActivePrincipalAccess } from '../application/active-principal-access.js'

export function createMysqlActivePrincipalAccess(connection: Pick<PoolConnection, 'execute'>): ActivePrincipalAccess {
  return {
    async isActive(userId, lock) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || (lock !== 'none' && lock !== 'share' && lock !== 'update')) return false
      const sql = lock === 'update'
        ? "SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE"
        : lock === 'share'
          ? "SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR SHARE"
          : "SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL"
      try {
        const [rows] = await connection.execute<RowDataPacket[]>(sql, [userId])
        return rows.length === 1
      } catch { throw Error('auth_principal_unavailable') }
    },
  }
}
