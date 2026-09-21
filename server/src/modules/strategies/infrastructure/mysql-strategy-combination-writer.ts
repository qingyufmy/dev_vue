import type { AdminPrincipalAccess } from '../../auth/index.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { StrategyCombinationWriter } from '../application/strategy-combination-writer.js'
import { compileStrategy, isIndependentRoleConfig } from '../application/strategy-service.js'
import type { CreateStrategyCombinationInput, CreateStrategyCombinationVersionInput, StrategyCompileResult, StrategyDetail } from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { readStrategyDetail } from './mysql-strategy-catalog.js'
import { executeStrategyWrite, type StrategyWriteResult } from './mysql-strategy-write-receipts.js'

interface StrategyLockRow extends RowDataPacket {
  id: string
  kind: 'analysis' | 'trader'
  scope: 'platform' | 'user'
  owner_user_id: number | null
  status: 'draft' | 'active' | 'retired'
  revision: string
}

interface PairRow extends RowDataPacket { trader_strategy_id: string | null }

export function createStrategyCombinationWriter(pool: Pool,
  administrators: (connection: PoolConnection) => AdminPrincipalAccess): StrategyCombinationWriter {
  return {
    async create(input) {
      const result = await executeStrategyWrite(pool, {
        actorUserId: input.userId, idempotencyKey: input.idempotencyKey, action: 'create_strategy_combination',
        targetId: null, expectedRevision: null, payload: combinationPayload(input),
      }, async connection => {
        const trader = validCompile(compileStrategy('trader', input.traderPromptText, input.traderConfig))
        const traderId = await insertStrategy(connection, input.userId, 'user', 'trader', `${input.name.trim()} · 交易执行`, input.description.trim(), input.traderPromptText, trader)
        const analysis = validCompile(compileStrategy('analysis', input.analysisPromptText, { ...input.analysisConfig, trader_strategy_id: traderId }))
        assertCompatibleCombination(analysis.normalizedConfig, trader.normalizedConfig)
        const analysisId = await insertStrategy(connection, input.userId, 'user', 'analysis', input.name.trim(), input.description.trim(), input.analysisPromptText, analysis)
        const detail = await readStrategyDetail(connection, input.userId, analysisId)
        if (!detail) throw new StrategyAccessError('strategy_write_result_invalid', 503)
        return { resourceId: analysisId, revision: detail.summary.revision, value: detail }
      }, combinationResult(input.userId, null, 1), async () => {})
      return result.value
    },

    async createVersion(input) {
      let analysisRow: StrategyLockRow | null = null
      let traderRow: StrategyLockRow | null = null
      let traderStrategyId: string | null = null
      const result = await executeStrategyWrite(pool, {
        actorUserId: input.userId, idempotencyKey: input.idempotencyKey, action: 'create_strategy_combination_version',
        targetId: input.analysisStrategyId, expectedRevision: input.expectedRevision,
        payload: { ...combinationPayload(input), traderExpectedRevision: input.traderExpectedRevision },
      }, async connection => {
        if (!analysisRow) throw new StrategyAccessError('strategy_not_found', 404)
        if (analysisRow.revision !== String(input.expectedRevision)) throw new StrategyAccessError('strategy_revision_conflict', 412)
        if (analysisRow.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)

        const trader = validCompile(compileStrategy('trader', input.traderPromptText, input.traderConfig))
        if (traderRow) {
          if (input.traderExpectedRevision !== Number(traderRow.revision)) throw new StrategyAccessError('strategy_revision_conflict', 412)
          if (traderRow.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
          await insertVersion(connection, traderRow.id, input.userId, input.traderPromptText, trader)
          await updateStrategy(connection, traderRow, `${input.name.trim()} · 交易执行`, input.description.trim(), input.status)
          traderStrategyId = traderRow.id
        } else {
          if (input.traderExpectedRevision !== null) throw new StrategyAccessError('strategy_revision_conflict', 412)
          traderStrategyId = await insertStrategy(connection, input.userId, analysisRow.scope, 'trader', `${input.name.trim()} · 交易执行`, input.description.trim(), input.traderPromptText, trader, input.status)
        }

        const analysis = validCompile(compileStrategy('analysis', input.analysisPromptText, { ...input.analysisConfig, trader_strategy_id: traderStrategyId }))
        assertCompatibleCombination(analysis.normalizedConfig, trader.normalizedConfig)
        await insertVersion(connection, analysisRow.id, input.userId, input.analysisPromptText, analysis)
        await updateStrategy(connection, analysisRow, input.name.trim(), input.description.trim(), input.status)
        const detail = await readStrategyDetail(connection, input.userId, analysisRow.id)
        if (!detail) throw new StrategyAccessError('strategy_write_result_invalid', 503)
        return { resourceId: analysisRow.id, revision: detail.summary.revision, value: detail }
      }, combinationResult(input.userId, input.analysisStrategyId, input.expectedRevision + 1), async connection => {
        const [pairs] = await connection.execute<PairRow[]>(`SELECT JSON_UNQUOTE(JSON_EXTRACT(v.config_json,'$.trader_strategy_id')) trader_strategy_id
          FROM strategy_versions v WHERE v.strategy_id=? ORDER BY v.version_number DESC LIMIT 1`, [input.analysisStrategyId])
        traderStrategyId = pairs[0]?.trader_strategy_id ?? null
        const ids = [input.analysisStrategyId, ...(traderStrategyId ? [traderStrategyId] : [])].sort()
        const placeholders = ids.map(() => '?').join(',')
        const [rows] = await connection.execute<StrategyLockRow[]>(`SELECT CAST(id AS CHAR) id,kind,scope,owner_user_id,status,CAST(revision AS CHAR) revision
          FROM strategies WHERE id IN (${placeholders}) AND deleted_at_utc IS NULL ORDER BY id FOR UPDATE`, ids)
        analysisRow = rows.find(row => row.id === input.analysisStrategyId) ?? null
        traderRow = traderStrategyId ? rows.find(row => row.id === traderStrategyId) ?? null : null
        if (!analysisRow || analysisRow.kind !== 'analysis') throw new StrategyAccessError('strategy_not_found', 404)
        if (analysisRow.scope === 'platform') {
          if (!await administrators(connection).isAdmin(input.userId, 'share')) throw new StrategyAccessError('strategy_admin_required', 403)
        } else if (analysisRow.owner_user_id !== input.userId) throw new StrategyAccessError('strategy_read_only', 403)
        if (traderStrategyId && (!traderRow || traderRow.kind !== 'trader' || traderRow.scope !== analysisRow.scope
          || traderRow.owner_user_id !== analysisRow.owner_user_id)) throw new StrategyAccessError('strategy_pair_invalid', 409)
      })
      return result.value
    },
  }
}

function combinationPayload(input: CreateStrategyCombinationInput | CreateStrategyCombinationVersionInput) {
  return { name: input.name, description: input.description, status: input.status ?? 'draft',
    analysis: { promptText: input.analysisPromptText, config: input.analysisConfig },
    trader: { promptText: input.traderPromptText, config: input.traderConfig } }
}

function validCompile(result: StrategyCompileResult) {
  if (!result.valid) throw new StrategyAccessError('strategy_compile_invalid', 422, result.issues)
  return result
}

function assertCompatibleCombination(analysisConfig: Record<string, unknown>, traderConfig: Record<string, unknown>) {
  if (isIndependentRoleConfig(analysisConfig) !== isIndependentRoleConfig(traderConfig)) {
    throw new StrategyAccessError('strategy_responsibility_mode_mismatch', 422)
  }
  if (!isIndependentRoleConfig(analysisConfig)) return
  const symbols = (value: Record<string, unknown>) => Array.isArray(value.symbols)
    ? [...value.symbols].map(String).sort() : []
  if (JSON.stringify(symbols(analysisConfig)) !== JSON.stringify(symbols(traderConfig))) {
    throw new StrategyAccessError('strategy_symbol_scope_mismatch', 422)
  }
}

async function insertStrategy(connection: PoolConnection, userId: number, scope: 'platform' | 'user', kind: 'analysis' | 'trader',
  name: string, description: string, promptText: string, compiled: StrategyCompileResult, status: 'draft' | 'active' = 'draft') {
  const [strategy] = await connection.execute<ResultSetHeader>(`INSERT INTO strategies
    (kind,scope,owner_user_id,name,description,status,revision,created_at_utc,updated_at_utc)
    VALUES (?,?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [kind, scope, scope === 'user' ? userId : null, name, description, status])
  const id = String(strategy.insertId)
  const versionId = await insertVersion(connection, id, userId, promptText, compiled)
  if (status === 'active') await connection.execute('UPDATE strategies SET active_version_id=? WHERE id=?', [versionId, id])
  return id
}

async function insertVersion(connection: PoolConnection, strategyId: string, userId: number, promptText: string, compiled: StrategyCompileResult) {
  const [numbers] = await connection.execute<(RowDataPacket & { next_version: number })[]>('SELECT COALESCE(MAX(version_number),0)+1 next_version FROM strategy_versions WHERE strategy_id=?', [strategyId])
  const next = Number(numbers[0]?.next_version)
  if (!Number.isSafeInteger(next) || next < 1 || next > 2147483647) throw new StrategyAccessError('strategy_version_invalid', 422)
  const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO strategy_versions
    (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc)
    VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [strategyId, next, promptText.trim(), compiled.promptHash,
    compiled.inputContractVersion, compiled.outputContractVersion, JSON.stringify(compiled.normalizedConfig), userId])
  return String(inserted.insertId)
}

async function updateStrategy(connection: PoolConnection, row: StrategyLockRow, name: string, description: string, status: 'draft' | 'active' | undefined) {
  const [versions] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT CAST(id AS CHAR) id FROM strategy_versions WHERE strategy_id=? ORDER BY version_number DESC LIMIT 1', [row.id])
  const versionId = versions[0]?.id
  if (!versionId) throw new StrategyAccessError('strategy_write_result_invalid', 503)
  const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategies SET name=?,description=?,status=COALESCE(?,status),
    active_version_id=CASE WHEN ?='active' THEN ? ELSE active_version_id END,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3)
    WHERE id=? AND revision=?`, [name, description, status ?? null, status ?? null, versionId, row.id, Number(row.revision)])
  if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
}

function combinationResult(userId: number, resourceId: string | null, revision: number) {
  return (value: unknown): value is StrategyWriteResult<StrategyDetail> => {
    const result = value as StrategyWriteResult<StrategyDetail> | null
    return !!result?.value?.summary && result.value.summary.kind === 'analysis'
      && result.resourceId === result.value.summary.id && (resourceId === null || result.resourceId === resourceId) && result.revision === revision
      && (result.value.summary.scope === 'platform' || result.value.summary.ownerUserId === userId)
  }
}
