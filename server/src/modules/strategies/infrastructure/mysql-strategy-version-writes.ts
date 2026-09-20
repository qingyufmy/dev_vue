import { strategyEditFields } from '../domain/strategy-edit-fields.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { CreateStrategyVersionInput, PublishStrategyVersionInput, RetireStrategyInput,
  StrategyCompileResult, StrategyDetail, StrategyKind } from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { writeOwnedStrategy } from './mysql-owned-strategy-write.js'

type ReadDetail = (connection: PoolConnection) => Promise<StrategyDetail | null>

export function createStrategyVersionWithReceipt(pool: Pool, input: CreateStrategyVersionInput,
  prepare: (kind: StrategyKind) => StrategyCompileResult, read: ReadDetail) {
  return writeOwnedStrategy(pool, input, 'create_version', { ...strategyEditFields(input), promptText: input.promptText, config: input.config }, async (connection, kind) => {
    const compiled = prepare(kind)
    const [numbers] = await connection.execute<(RowDataPacket & { next_version: number })[]>(
      'SELECT COALESCE(MAX(version_number),0)+1 next_version FROM strategy_versions WHERE strategy_id=?', [input.strategyId])
    const nextVersion = Number(numbers[0]?.next_version)
    if (!Number.isSafeInteger(nextVersion) || nextVersion < 1 || nextVersion > 2147483647) throw new StrategyAccessError('strategy_version_invalid', 422)
    const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO strategy_versions
      (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc)
      VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [input.strategyId, nextVersion, input.promptText.trim(), compiled.promptHash,
      compiled.inputContractVersion, compiled.outputContractVersion, JSON.stringify(compiled.normalizedConfig), input.userId])
    const [updated] = await connection.execute<ResultSetHeader>(
      "UPDATE strategies SET name=COALESCE(?,name),description=COALESCE(?,description),status=COALESCE(?,status),active_version_id=CASE WHEN ?='active' THEN ? ELSE active_version_id END,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?",
    [input.name ?? null, input.description ?? null, input.status ?? null, input.status ?? null, inserted.insertId, input.strategyId, input.userId, input.expectedRevision])
    if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
  }, read)
}

export function publishStrategyVersionWithReceipt(pool: Pool, input: PublishStrategyVersionInput, read: ReadDetail) {
  return writeOwnedStrategy(pool, input, 'publish_version', { versionId: input.versionId }, async connection => {
    const [versions] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM strategy_versions WHERE id=? AND strategy_id=? LIMIT 1', [input.versionId, input.strategyId])
    if (versions.length !== 1) throw new StrategyAccessError('strategy_version_not_found', 404)
    await rebindPublishedVersion(connection, input.userId, input.strategyId, input.versionId)
    const [updated] = await connection.execute<ResultSetHeader>(
      "UPDATE strategies SET active_version_id=?,status='active',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?",
    [input.versionId, input.strategyId, input.userId, input.expectedRevision])
    if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
  }, read)
}

export function retireStrategyWithReceipt(pool: Pool, input: RetireStrategyInput, read: ReadDetail) {
  return writeOwnedStrategy(pool, input, 'retire_strategy', {}, async connection => {
    const [updated] = await connection.execute<ResultSetHeader>(
      "UPDATE strategies SET status='retired',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?",
    [input.strategyId, input.userId, input.expectedRevision])
    if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
  }, read)
}

async function rebindPublishedVersion(connection: PoolConnection, userId: number, strategyId: string, versionId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM strategy_subscriptions WHERE user_id=? AND status<>'ended' AND ((analysis_strategy_id=? AND analysis_strategy_version_id<>?) OR (trader_strategy_id=? AND (trader_strategy_version_id IS NULL OR trader_strategy_version_id<>?))) ORDER BY id FOR UPDATE`, [userId, strategyId, versionId, strategyId, versionId])
  const ids = rows.map(row => row.id)
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  await connection.execute<ResultSetHeader>(`UPDATE strategy_subscriptions SET analysis_strategy_version_id=CASE WHEN analysis_strategy_id=? THEN ? ELSE analysis_strategy_version_id END,trader_strategy_version_id=CASE WHEN trader_strategy_id=? THEN ? ELSE trader_strategy_version_id END,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id IN (${placeholders})`, [strategyId, versionId, strategyId, versionId, ...ids])
}
