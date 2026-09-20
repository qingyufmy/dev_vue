import { isDeepStrictEqual } from 'node:util'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { RuntimeMemoryPreparationWriter } from '../application/runtime-memory-preparation-writer.js'
import { ReviewError } from '../domain/review.js'
import { reviewIsoTime, reviewSqlTime } from './review-sql-time.js'

const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
  && BigInt(value) <= 18446744073709551615n
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(value)

export function createMysqlRuntimeMemoryPreparationWriter(connection: Pick<PoolConnection, 'execute'>): RuntimeMemoryPreparationWriter {
  return { async record(value) {
    const input = structuredClone(value), occurredAt = reviewSqlTime(input.occurredAt)
    if (!Number.isSafeInteger(input.userId) || input.userId < 1 || !positive(input.strategyId) || !positive(input.libraryRevision)
      || !['analysis', 'trader'].includes(input.runtimeKind) || typeof input.runtimeId !== 'string' || !/^[A-Za-z0-9._:-]{1,191}$/.test(input.runtimeId)
      || ![input.inputSnapshotId, input.libraryId, input.revisionId].every(id) || !digest(input.inputSnapshotHash) || !digest(input.contentHash)
      || !Number.isSafeInteger(input.versionNumber) || input.versionNumber < 1
      || !Number.isSafeInteger(input.contentBytes) || input.contentBytes < 0 || input.contentBytes > 65_536
      || !Number.isSafeInteger(input.maxContextTokens) || input.maxContextTokens < 1
      || input.estimatedTokens !== Math.ceil(input.contentBytes / 4) || input.estimatedTokens > input.maxContextTokens
      || input.estimateMethod !== 'utf8_bytes_div4_v1') throw new ReviewError('strategy_memory_preparation_invalid', 422)
    const [sources] = await connection.execute<RowDataPacket[]>(`SELECT CAST(l.revision AS CHAR) library_revision,r.version_number,
      r.content_sha256,SHA2(r.content_text,256) actual_sha256,OCTET_LENGTH(r.content_text) content_bytes,l.max_context_tokens
      FROM strategy_memory_libraries_v4 l INNER JOIN strategy_memory_library_revisions_v4 r ON r.id=l.current_revision_id AND r.library_id=l.id
      INNER JOIN strategies s ON s.id=l.strategy_id WHERE l.id=? AND r.id=? AND s.id=? AND s.kind=?
        AND l.mode='active' AND l.status='active' AND s.status='active' AND s.deleted_at_utc IS NULL
        AND ((s.scope='platform' AND s.owner_user_id IS NULL AND l.owner_user_id IS NULL)
          OR (s.scope='user' AND s.owner_user_id=? AND l.owner_user_id=s.owner_user_id)) LIMIT 2 FOR SHARE`,
    [input.libraryId, input.revisionId, input.strategyId, input.runtimeKind, input.userId])
    const source = sources[0]
    const contentBytes = typeof source?.content_bytes === 'string' && /^(0|[1-9]\d*)$/.test(source.content_bytes)
      ? Number(source.content_bytes) : source?.content_bytes
    if (sources.length !== 1 || source!.library_revision !== input.libraryRevision || source!.version_number !== input.versionNumber
      || source!.content_sha256 !== input.contentHash || source!.actual_sha256 !== input.contentHash
      || contentBytes !== input.contentBytes || source!.max_context_tokens !== input.maxContextTokens) {
      throw new ReviewError('strategy_memory_preparation_stale', 409)
    }
    const context = { schema_version: 2, stage: 'snapshot_prepared', library_revision: input.libraryRevision,
      version_number: input.versionNumber, content_sha256: input.contentHash, content_bytes: input.contentBytes, max_context_tokens: input.maxContextTokens }
    const read = async () => {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT user_id,CAST(strategy_id AS CHAR) strategy_id,library_id,library_revision_id,
        injected,matched_context_json,token_count,occurred_at_utc,record_version,input_snapshot_id,input_snapshot_sha256,estimated_token_count,token_estimate_method
        FROM strategy_memory_injection_logs_v4 WHERE runtime_kind=? AND runtime_id=? AND library_revision_id=? LIMIT 2 FOR UPDATE`,
      [input.runtimeKind, input.runtimeId, input.revisionId])
      return rows
    }
    const matches = (rows: RowDataPacket[]) => {
      const row = rows[0]
      let same = false
      if (rows.length === 1) {
        const contextValue: unknown = typeof row!.matched_context_json === 'string' ? JSON.parse(row!.matched_context_json) : row!.matched_context_json
        same = row!.user_id === input.userId && row!.strategy_id === input.strategyId && row!.library_id === input.libraryId
          && row!.library_revision_id === input.revisionId && row!.injected === 0 && row!.token_count === null && row!.record_version === 2
          && row!.input_snapshot_id === input.inputSnapshotId && row!.input_snapshot_sha256 === input.inputSnapshotHash
          && row!.estimated_token_count === input.estimatedTokens && row!.token_estimate_method === input.estimateMethod
          && reviewSqlTime(reviewIsoTime(row!.occurred_at_utc as Date | string)) === occurredAt && isDeepStrictEqual(contextValue, context)
      }
      if (!same) throw new ReviewError('strategy_memory_preparation_conflict', 409)
    }
    const existing = await read()
    if (existing.length) { matches(existing); return }
    const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO strategy_memory_injection_logs_v4
      (user_id,strategy_id,library_id,library_revision_id,runtime_kind,runtime_id,injected,matched_context_json,token_count,occurred_at_utc,
      record_version,input_snapshot_id,input_snapshot_sha256,estimated_token_count,token_estimate_method)
      VALUES (?,?,?,?,?,?,0,?,NULL,?,2,?,?,?,?)`, [input.userId, input.strategyId, input.libraryId, input.revisionId,
    input.runtimeKind, input.runtimeId, JSON.stringify(context), occurredAt, input.inputSnapshotId, input.inputSnapshotHash, input.estimatedTokens, input.estimateMethod])
    if (inserted.affectedRows !== 1) throw new ReviewError('strategy_memory_preparation_write_failed', 500)
    matches(await read())
  } }
}
