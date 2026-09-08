import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AdminPrincipalAccess } from '../application/admin-principal-access.js'

export function createMysqlAdminPrincipalAccess(connection: Pick<PoolConnection, 'execute'>): AdminPrincipalAccess {
  return {
    async isAdmin(userId, lock) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || (lock !== 'none' && lock !== 'share')) return false
      try {
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM users
          WHERE id=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL LIMIT 1${lock === 'share' ? ' FOR SHARE' : ''}`, [userId])
        return rows.length === 1
      } catch { throw Error('auth_principal_unavailable') }
    },
  }
}
