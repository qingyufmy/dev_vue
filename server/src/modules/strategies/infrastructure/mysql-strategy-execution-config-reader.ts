import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { sha256Canonical } from '../../../shared/canonical-json.js'
import type { StrategyExecutionConfigReader } from '../application/strategy-execution-config-reader.js'

interface ConfigRow extends RowDataPacket {
  strategy_id: string; version_id: string; prompt_text: string; prompt_sha256: string
  config_json: string | Record<string, unknown>
}

export function createStrategyExecutionConfigReader(connection: Pick<PoolConnection, 'execute'>): StrategyExecutionConfigReader {
  return { async read(scope) {
    if (!/^[a-f0-9]{64}$/.test(scope.promptHash) || !/^[a-f0-9]{64}$/.test(scope.configHash)) return null
    const [rows] = await connection.execute<ConfigRow[]>(`SELECT CAST(st.id AS CHAR) strategy_id,CAST(v.id AS CHAR) version_id,
        v.prompt_text,v.prompt_sha256,v.config_json
      FROM strategy_subscriptions s
      INNER JOIN strategies st ON st.id=s.trader_strategy_id
        AND st.kind='trader' AND st.status='active' AND st.deleted_at_utc IS NULL
        AND (st.scope='platform' OR st.owner_user_id=s.user_id)
      INNER JOIN strategy_versions v ON v.id=st.active_version_id AND v.strategy_id=st.id
      INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id
        AND own.role='owner' AND own.revoked_at_utc IS NULL
      WHERE s.id=? AND s.user_id=? AND s.trading_account_id=? AND s.revision=? AND s.status='active'
        AND s.trader_enabled=1 AND s.trader_strategy_id=? AND st.active_version_id=?
      LIMIT 2 FOR SHARE`, [scope.subscriptionId, scope.userId, scope.accountId, scope.subscriptionRevision,
      scope.traderStrategyId, scope.traderStrategyVersionId])
    if (rows.length !== 1) return null
    const row = rows[0]!
    if (row.strategy_id !== scope.traderStrategyId || row.version_id !== scope.traderStrategyVersionId
      || row.prompt_sha256 !== scope.promptHash || typeof row.prompt_text !== 'string'
      || createHash('sha256').update(row.prompt_text).digest('hex') !== scope.promptHash) return null
    try {
      const config: unknown = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json
      if (!config || typeof config !== 'object' || Array.isArray(config) || sha256Canonical(config) !== scope.configHash) return null
      return { strategyId: row.strategy_id, versionId: row.version_id, promptHash: scope.promptHash,
        configHash: scope.configHash, config: structuredClone(config) as Record<string, unknown> }
    } catch { return null }
  } }
}
