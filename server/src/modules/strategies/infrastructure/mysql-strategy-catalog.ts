import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { StrategyCatalog } from '../application/strategy-service.js'
import type { StrategyKind, StrategySummary, StrategyVersion } from '../domain/strategy.js'

interface StrategyRow extends RowDataPacket {
  id: string
  kind: StrategyKind
  scope: 'platform' | 'user'
  owner_user_id: number | null
  name: string
  description: string
  status: 'draft' | 'active' | 'retired'
  active_version_id: string | null
  revision: number
}

interface VersionRow extends RowDataPacket {
  id: string
  strategy_id: string
  kind: StrategyKind
  version_number: number
  prompt_text: string
  prompt_sha256: string
  config_json: string | object
  input_contract_version: string
  output_contract_version: string
}

const summary = (row: StrategyRow): StrategySummary => ({
  id: row.id, kind: row.kind, scope: row.scope, ownerUserId: row.owner_user_id, name: row.name,
  description: row.description, status: row.status, activeVersionId: row.active_version_id, revision: Number(row.revision),
})

export class MysqlStrategyCatalog implements StrategyCatalog {
  constructor(private readonly pool: Pool) {}

  async listAvailable(userId: number, kind?: StrategyKind) {
    const params: Array<number | string> = [userId]
    let kindSql = ''
    if (kind) { kindSql = ' AND s.kind=?'; params.push(kind) }
    const [rows] = await this.pool.execute<StrategyRow[]>(`SELECT CAST(s.id AS CHAR) id,s.kind,s.scope,s.owner_user_id,s.name,s.description,s.status,CAST(s.active_version_id AS CHAR) active_version_id,s.revision FROM strategies s WHERE s.deleted_at_utc IS NULL AND (s.scope='platform' OR s.owner_user_id=?)${kindSql} ORDER BY s.kind,s.name,s.id`, params)
    return rows.map(summary)
  }

  async findActiveVersion(userId: number, strategyId: string) {
    const [rows] = await this.pool.execute<VersionRow[]>(`SELECT CAST(v.id AS CHAR) id,CAST(v.strategy_id AS CHAR) strategy_id,s.kind,v.version_number,v.prompt_text,v.prompt_sha256,v.config_json,v.input_contract_version,v.output_contract_version FROM strategies s INNER JOIN strategy_versions v ON v.id=s.active_version_id AND v.strategy_id=s.id WHERE s.id=? AND s.status='active' AND s.deleted_at_utc IS NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1`, [strategyId, userId])
    const row = rows[0]
    if (!row) return null
    const version: StrategyVersion = {
      id: row.id, strategyId: row.strategy_id, kind: row.kind, version: Number(row.version_number), promptText: row.prompt_text,
      promptHash: row.prompt_sha256, config: parseConfig(row.config_json), inputContractVersion: row.input_contract_version, outputContractVersion: row.output_contract_version,
    }
    return version
  }
}

function parseConfig(value: string | object) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
