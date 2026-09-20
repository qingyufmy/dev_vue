import { strategyEditFields } from '../domain/strategy-edit-fields.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AdminPrincipalAccess } from '../../auth/index.js'
import type { PlatformStrategyPublisher } from '../application/platform-strategy-publisher.js'
import { compileStrategy } from '../application/strategy-service.js'
import { StrategyAccessError, type StrategyDetail } from '../domain/strategy.js'
import { executeStrategyWrite, type StrategyWriteResult } from './mysql-strategy-write-receipts.js'
import { readStrategyDetail } from './mysql-strategy-catalog.js'

export function createPlatformStrategyPublisher(pool: Pool, administrators: (connection: PoolConnection) => AdminPrincipalAccess): PlatformStrategyPublisher {
  return { async createVersion(input) {
    let current: StrategyDetail | null = null
    const result = await executeStrategyWrite(pool, { actorUserId: input.userId, idempotencyKey: input.idempotencyKey,
      action: 'create_version', targetId: input.strategyId, expectedRevision: input.expectedRevision,
      payload: { ...strategyEditFields(input), promptText: input.promptText, config: input.config, scope: 'platform' } }, async connection => {
      if (!current) throw new StrategyAccessError('strategy_not_found', 404)
      if (current.summary.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
      if (current.summary.revision !== input.expectedRevision) throw new StrategyAccessError('strategy_revision_conflict', 412)
      const compiled = compileStrategy(current.summary.kind, input.promptText, input.config)
      if (!compiled.valid) throw new StrategyAccessError('strategy_compile_invalid', 422, compiled.issues)
      const next = Math.max(0, ...current.versions.map(v => v.version)) + 1
      if (!Number.isSafeInteger(next) || next > 2147483647) throw new StrategyAccessError('strategy_version_invalid', 422)
      const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO strategy_versions
        (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc)
        VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [input.strategyId, next, input.promptText.trim(), compiled.promptHash,
        compiled.inputContractVersion, compiled.outputContractVersion, JSON.stringify(compiled.normalizedConfig), input.userId])
      const [updated] = await connection.execute<ResultSetHeader>("UPDATE strategies SET name=COALESCE(?,name),description=COALESCE(?,description),status=COALESCE(?,status),active_version_id=CASE WHEN ?='active' THEN ? ELSE active_version_id END,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND scope='platform' AND revision=?", [input.name ?? null, input.description ?? null, input.status ?? null, input.status ?? null, inserted.insertId, input.strategyId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
      const detail = await readStrategyDetail(connection, input.userId, input.strategyId)
      if (!detail) throw new StrategyAccessError('strategy_write_result_invalid', 503)
      return { resourceId: input.strategyId, revision: detail.summary.revision, value: detail }
    }, (value): value is StrategyWriteResult<StrategyDetail> => {
      const item = value as StrategyWriteResult<StrategyDetail> | null
      return !!item && item.resourceId === input.strategyId && item.revision === input.expectedRevision + 1
        && item.value?.summary?.scope === 'platform' && item.value.summary.id === input.strategyId && item.value.summary.revision === item.revision
    }, async connection => {
      if (!await administrators(connection).isAdmin(input.userId, 'share')) throw new StrategyAccessError('strategy_admin_required', 403)
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM strategies WHERE id=? AND scope='platform' AND deleted_at_utc IS NULL FOR UPDATE", [input.strategyId])
      if (rows.length !== 1) throw new StrategyAccessError('strategy_not_found', 404)
      current = await readStrategyDetail(connection, input.userId, input.strategyId)
    })
    return result.value
  }, async publish(input) {
    let current: StrategyDetail | null = null
    const result = await executeStrategyWrite(pool, { actorUserId: input.userId, idempotencyKey: input.idempotencyKey,
      action: 'publish_version', targetId: input.strategyId, expectedRevision: input.expectedRevision,
      payload: { versionId: input.versionId, scope: 'platform' } }, async connection => {
      if (!current) throw new StrategyAccessError('strategy_not_found', 404)
      if (current.summary.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
      if (current.summary.revision !== input.expectedRevision) throw new StrategyAccessError('strategy_revision_conflict', 412)
      const version = current.versions.find(item => item.id === input.versionId)
      if (!version) throw new StrategyAccessError('strategy_version_not_found', 404)
      const compiled = compileStrategy(current.summary.kind, version.promptText, version.config)
      if (!compiled.valid || compiled.promptHash !== version.promptHash
        || compiled.inputContractVersion !== version.inputContractVersion || compiled.outputContractVersion !== version.outputContractVersion) {
        throw new StrategyAccessError('strategy_compile_invalid', 422)
      }
      await connection.execute("UPDATE strategies SET active_version_id=?,status='active',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND scope='platform' AND revision=?",
        [input.versionId, input.strategyId, input.expectedRevision])
      const detail = await readStrategyDetail(connection, input.userId, input.strategyId)
      if (!detail) throw new StrategyAccessError('strategy_write_result_invalid', 503)
      return { resourceId: input.strategyId, revision: detail.summary.revision, value: detail }
    }, (value): value is StrategyWriteResult<StrategyDetail> => {
      const item = value as StrategyWriteResult<StrategyDetail> | null
      return !!item && item.resourceId === input.strategyId && item.revision === input.expectedRevision + 1
        && item.value?.summary?.scope === 'platform' && item.value.summary.id === input.strategyId
        && item.value.summary.activeVersionId === input.versionId && item.value.summary.revision === item.revision
    }, async connection => {
      if (!await administrators(connection).isAdmin(input.userId, 'share')) throw new StrategyAccessError('strategy_admin_required', 403)
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT id FROM strategies WHERE id=? AND scope='platform' AND deleted_at_utc IS NULL FOR UPDATE", [input.strategyId])
      if (rows.length !== 1) throw new StrategyAccessError('strategy_not_found', 404)
      current = await readStrategyDetail(connection, input.userId, input.strategyId)
    })
    return result.value
  } }
}
