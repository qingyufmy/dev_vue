import { StrategyAccessError } from '../domain/strategy.js'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { RuntimeStrategyAccess } from '../application/runtime-strategy-access.js'

export function createRuntimeStrategyAccess(connection: Pick<PoolConnection, 'execute'>): RuntimeStrategyAccess {
  return {
    async readModelProfileId(userId, strategyId, versionId) {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT JSON_UNQUOTE(JSON_EXTRACT(v.config_json,'$.model_profile_id')) model_id
        FROM strategies s JOIN strategy_versions v ON v.id=s.active_version_id AND v.strategy_id=s.id
        WHERE s.id=? AND v.id=? AND s.status='active' AND s.deleted_at_utc IS NULL
          AND (s.scope='platform' OR s.owner_user_id=?)`, [strategyId, versionId, userId])
      if (!rows.length) throw new StrategyAccessError('strategy_not_found', 404)
      const id = rows[0]?.model_id
      return typeof id === 'string' && /^[1-9]\d*$/.test(id) ? id : null
    },
    async canUseCurrent(userId, strategyId, versionId) {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM strategies
        WHERE id=? AND active_version_id=? AND status='active' AND deleted_at_utc IS NULL
          AND (scope='platform' OR owner_user_id=?)`, [strategyId, versionId, userId])
      return rows.length === 1
    },
    async canUseFrozenReview(userId, strategyId) {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM strategies
        WHERE id=? AND deleted_at_utc IS NULL AND (scope='platform' OR owner_user_id=?)`, [strategyId, userId])
      return rows.length === 1
    },
  }
}
