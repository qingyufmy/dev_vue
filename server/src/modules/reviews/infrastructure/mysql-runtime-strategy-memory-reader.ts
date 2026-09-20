import { createHash } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { RuntimeStrategyMemory, RuntimeStrategyMemoryReader } from '../application/runtime-strategy-memory-reader.js'
import { ReviewError } from '../domain/review.js'

const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
  && BigInt(value) <= 18446744073709551615n
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const maximumContentBytes = 65_536

interface MemoryRow extends RowDataPacket {
  strategy_id: string
  library_id: string | null
  library_revision: string | null
  mode: string | null
  status: string | null
  current_revision_id: string | null
  revision_id: string | null
  version_number: number | null
  content_sha256: string | null
  content_text: string | null
  content_bytes: number | string | null
  max_context_tokens: number | null
  ownership_valid: number | null
}

export function createMysqlRuntimeStrategyMemoryReader(connection: Pick<PoolConnection, 'execute'>): RuntimeStrategyMemoryReader {
  return { async read(input) {
    const scope = { ...input }
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !positive(scope.strategyId)
      || !['analysis', 'trader'].includes(scope.strategyKind)) throw new ReviewError('strategy_memory_scope_invalid', 422)
    const [rows] = await connection.execute<MemoryRow[]>(`SELECT CAST(s.id AS CHAR) strategy_id,l.id library_id,
      CAST(l.revision AS CHAR) library_revision,l.mode,l.status,l.current_revision_id,r.id revision_id,r.version_number,
      r.content_sha256,OCTET_LENGTH(r.content_text) content_bytes,l.max_context_tokens,
      CASE WHEN (s.scope='platform' AND s.owner_user_id IS NULL AND l.owner_user_id IS NULL)
        OR (s.scope='user' AND s.owner_user_id=? AND l.owner_user_id=s.owner_user_id) THEN 1 ELSE 0 END ownership_valid,
      CASE WHEN l.mode='active' AND l.status='active' AND OCTET_LENGTH(r.content_text)<=? THEN r.content_text ELSE NULL END content_text
      FROM strategies s LEFT JOIN strategy_memory_libraries_v4 l ON l.strategy_id=s.id
      LEFT JOIN strategy_memory_library_revisions_v4 r ON r.id=l.current_revision_id AND r.library_id=l.id
      WHERE s.id=? AND s.kind=? AND s.status='active' AND s.deleted_at_utc IS NULL
        AND ((s.scope='platform' AND s.owner_user_id IS NULL) OR (s.scope='user' AND s.owner_user_id=?))
      LIMIT 2 FOR SHARE`, [scope.userId, maximumContentBytes, scope.strategyId, scope.strategyKind, scope.userId])
    if (rows.length !== 1 || rows[0]!.strategy_id !== scope.strategyId) throw new ReviewError('strategy_memory_unavailable', 409)
    const row = rows[0]!
    if (row.library_id === null) return { state: 'absent', strategyId: scope.strategyId }
    const fail = () => { throw new ReviewError('strategy_memory_evidence_invalid', 409) }
    if (Number(row.ownership_valid) !== 1 || !positive(row.library_revision)
      || !['off', 'shadow', 'active'].includes(row.mode ?? '') || !['active', 'revalidating', 'retired'].includes(row.status ?? '')
      || !Number.isSafeInteger(row.max_context_tokens) || row.max_context_tokens! < 1) return fail()
    if (row.current_revision_id !== null && (row.revision_id !== row.current_revision_id
      || !Number.isSafeInteger(row.version_number) || row.version_number! < 1 || !/^[a-f0-9]{64}$/.test(row.content_sha256 ?? ''))) return fail()
    const active = row.mode === 'active' && row.status === 'active'
    const contentBytes = typeof row.content_bytes === 'string' && /^(0|[1-9]\d*)$/.test(row.content_bytes) ? Number(row.content_bytes) : row.content_bytes
    if (active && (row.current_revision_id === null || typeof row.content_text !== 'string'
      || typeof contentBytes !== 'number' || !Number.isSafeInteger(contentBytes) || contentBytes > maximumContentBytes
      || Buffer.byteLength(row.content_text, 'utf8') !== contentBytes || hash(row.content_text) !== row.content_sha256)) return fail()
    return { state: active ? 'ready' : 'disabled', strategyId: scope.strategyId, libraryId: row.library_id,
      libraryRevision: row.library_revision!, mode: row.mode as 'off' | 'shadow' | 'active', status: row.status as 'active' | 'revalidating' | 'retired',
      revisionId: row.current_revision_id, versionNumber: row.current_revision_id === null ? null : row.version_number,
      contentHash: row.current_revision_id === null ? null : row.content_sha256,
      contentText: active ? row.content_text : null, maxContextTokens: row.max_context_tokens! } satisfies RuntimeStrategyMemory
  } }
}
