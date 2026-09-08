import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AnalysisStrategyAccess } from '../application/analysis-strategy-access.js'

export function createMysqlAnalysisStrategyAccess(connection: Pick<PoolConnection, 'execute'>): AnalysisStrategyAccess {
  return {
    async canUse(userId, strategyId) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || typeof strategyId !== 'string'
        || !/^[1-9][0-9]{0,19}$/.test(strategyId) || BigInt(strategyId) > 18446744073709551615n) return false
      try {
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT s.id
          FROM strategies s WHERE s.id=? AND s.kind='analysis' AND s.status='active' AND s.active_version_id IS NOT NULL
            AND s.deleted_at_utc IS NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1 FOR SHARE`, [strategyId, userId])
        return rows.length === 1
      } catch { throw Error('strategy_access_unavailable') }
    },
  }
}
