import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MacroSnapshotReader } from '../application/analysis-context-builder.js'
import type { JsonObject } from '../domain/inference.js'
import { contentHash, InferenceError } from '../domain/inference.js'

interface MacroRow extends RowDataPacket {
  id: string
  owner_scope: 'platform' | 'user'
  revision: number
  observed_at_utc: Date
  valid_until_utc: Date
  content_sha256: string
  payload_json: string | object
}

export class MysqlMacroSnapshotReader implements MacroSnapshotReader {
  constructor(private readonly pool: Pool) {}

  async latest(userId: number, now: string) {
    const [rows] = await this.pool.execute<MacroRow[]>(`SELECT id,owner_scope,revision,observed_at_utc,valid_until_utc,content_sha256,payload_json FROM macro_research_snapshots WHERE valid_until_utc>? AND (owner_scope='platform' OR owner_user_id=?) ORDER BY (owner_user_id IS NOT NULL) DESC,observed_at_utc DESC,id DESC LIMIT 1`, [now, userId])
    const row = rows[0]
    if (!row) return null
    const payload = (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) as JsonObject
    if (contentHash(payload) !== row.content_sha256) throw new InferenceError('macro_snapshot_hash_mismatch', 500)
    return {
      id: row.id, scope: row.owner_scope, revision: Number(row.revision), observed_at: row.observed_at_utc.toISOString(),
      valid_until: row.valid_until_utc.toISOString(), content_sha256: row.content_sha256, payload,
    } satisfies JsonObject
  }
}
