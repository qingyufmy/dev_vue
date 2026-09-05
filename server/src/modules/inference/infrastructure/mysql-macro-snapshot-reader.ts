import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MacroSnapshotReader } from '../application/analysis-context-builder.js'
import type { JsonObject } from '../domain/inference.js'
import { contentHash, InferenceError } from '../domain/inference.js'

interface MacroRow extends RowDataPacket {
  id: string
  revision: number
  schema_version: number
  data_cutoff_at_utc: Date
  published_at_utc: Date
  valid_until_utc: Date
  freshness_status: 'fresh' | 'stale' | 'partial' | 'unavailable'
  health_status: 'healthy' | 'degraded' | 'failed'
  horizon: string
  content_sha256: string
  payload_json: string | object
}

export class MysqlMacroSnapshotReader implements MacroSnapshotReader {
  constructor(private readonly pool: Pool) {}

  async latest(input: { now: string; acceptedSchemaVersions: number[]; maxAgeSeconds: number }) {
    if (input.acceptedSchemaVersions.length < 1) return null
    const placeholders = input.acceptedSchemaVersions.map(() => '?').join(',')
    const [rows] = await this.pool.execute<MacroRow[]>(`SELECT id,revision,schema_version,data_cutoff_at_utc,published_at_utc,valid_until_utc,freshness_status,health_status,horizon,content_sha256,payload_json FROM macro_research_snapshots WHERE owner_scope='platform' AND owner_user_id IS NULL AND publication_status='published' AND schema_version IN (${placeholders}) AND published_at_utc<=? AND valid_until_utc>? AND data_cutoff_at_utc<=? AND data_cutoff_at_utc>=TIMESTAMPADD(SECOND,-?,?) AND freshness_status IN ('fresh','partial') AND health_status IN ('healthy','degraded') ORDER BY published_at_utc DESC,id DESC LIMIT 1`, [
      ...input.acceptedSchemaVersions, input.now, input.now, input.now, input.maxAgeSeconds, input.now,
    ])
    const row = rows[0]
    if (!row) return null
    let payload: JsonObject
    try {
      payload = (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) as JsonObject
    } catch {
      throw new InferenceError('macro_snapshot_payload_invalid', 500)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new InferenceError('macro_snapshot_payload_invalid', 500)
    }
    if (contentHash(payload) !== row.content_sha256) throw new InferenceError('macro_snapshot_hash_mismatch', 500)
    const evidence = payload.analysis_evidence
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new InferenceError('macro_snapshot_evidence_invalid', 500)
    return {
      status: 'available', id: row.id, revision: Number(row.revision), schema_version: Number(row.schema_version),
      data_cutoff_at: row.data_cutoff_at_utc.toISOString(), published_at: row.published_at_utc.toISOString(),
      valid_until: row.valid_until_utc.toISOString(), freshness: row.freshness_status, health: row.health_status,
      horizon: row.horizon, content_sha256: row.content_sha256, evidence: evidence as JsonObject,
    } satisfies JsonObject
  }
}
