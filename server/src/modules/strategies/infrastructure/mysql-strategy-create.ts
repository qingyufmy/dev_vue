import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type { PreparedStrategyDraft } from '../application/strategy-service.js'
import type { CreateStrategyInput, StrategyDetail } from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { executeStrategyWrite, type StrategyWriteResult } from './mysql-strategy-write-receipts.js'

export async function createStrategyWithReceipt(pool: Pool, input: CreateStrategyInput,
  prepare: () => PreparedStrategyDraft,
  read: (connection: PoolConnection, strategyId: string) => Promise<StrategyDetail | null>): Promise<StrategyDetail> {
  const outcome = await executeStrategyWrite(pool, { actorUserId: input.userId, idempotencyKey: input.idempotencyKey,
    action: 'create_strategy', targetId: null, expectedRevision: null,
    payload: { kind: input.kind, name: input.name, description: input.description, promptText: input.promptText, config: input.config } },
  async connection => {
    const draft = prepare()
    const [strategy] = await connection.execute<ResultSetHeader>(`INSERT INTO strategies
      (kind,scope,owner_user_id,name,description,status,revision,created_at_utc,updated_at_utc)
      VALUES (?,'user',?,?,?,'draft',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [input.kind, input.userId, draft.name, draft.description])
    await connection.execute(`INSERT INTO strategy_versions
      (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc)
      VALUES (?,1,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [strategy.insertId, draft.promptText, draft.compiled.promptHash,
      draft.compiled.inputContractVersion, draft.compiled.outputContractVersion, JSON.stringify(draft.compiled.normalizedConfig), input.userId])
    const detail = await read(connection, String(strategy.insertId))
    if (!detail) throw new StrategyAccessError('strategy_write_result_invalid', 503)
    return { resourceId: detail.summary.id, revision: detail.summary.revision, value: detail }
  }, (result): result is StrategyWriteResult<StrategyDetail> => {
    const item = result as StrategyWriteResult<StrategyDetail> | null
    return !!item && !!item.value?.summary && item.value.summary.id === item.resourceId && item.revision === 1
      && item.value.summary.revision === 1 && item.value.summary.ownerUserId === input.userId
      && item.value.summary.kind === input.kind && item.value.summary.scope === 'user' && item.value.summary.status === 'draft'
      && Array.isArray(item.value.versions) && item.value.versions.length === 1
      && item.value.versions[0]?.strategyId === item.resourceId && item.value.versions[0]?.version === 1
  }, async () => { /* Creating a new private strategy needs the active actor check; there is no existing target. */ })
  return outcome.value
}
