import { assertStrategySymbol } from '../domain/strategy-runtime-settings.js'
import type { TraderControlInput } from '../application/trader-control.js'
import { setAccountTrader } from './mysql-trader-control.js'
import { strategySqlTime, strategyIsoTime } from './strategy-sql-time.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { PreparedStrategyDraft, PreparedSubscriptionCreate, PreparedSubscriptionUpdate, StrategyCatalog, StrategyManagementRepository } from '../application/strategy-service.js'
import type {
  CreateStrategyInput, CreateStrategySubscriptionInput, CreateStrategyVersionInput, PublishStrategyVersionInput,
  RetireStrategyInput, StrategyCompileResult, StrategyDetail, StrategyKind, StrategySubscription, StrategySummary, StrategyVersion,
  UpdateStrategyMetadataInput, UpdateStrategySubscriptionInput,
} from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { updateStrategyMetadataWithReceipt } from './mysql-strategy-metadata.js'
import { createStrategyWithReceipt } from './mysql-strategy-create.js'
import { createStrategyVersionWithReceipt, publishStrategyVersionWithReceipt, retireStrategyWithReceipt } from './mysql-strategy-version-writes.js'
import { executeStrategyWrite, type StrategyWriteResult } from './mysql-strategy-write-receipts.js'
import { initializeSubscriptionExecutionPreferences } from './mysql-subscription-execution-preferences.js'

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

interface VersionDetailRow extends VersionRow {
  created_by_user_id: number
  created_at_utc: Date
}

interface SubscriptionRow extends RowDataPacket {
  id: string
  user_id: number
  trading_account_id: string
  standard_symbol: string
  analysis_strategy_id: string
  analysis_strategy_version_id: string
  trader_strategy_id: string | null
  trader_strategy_version_id: string | null
  analysis_enabled: number
  trader_enabled: number
  trade_send_enabled: number
  status: 'active' | 'paused' | 'ended'
  revision: number
  created_at_utc: Date
  updated_at_utc: Date
  cadence_seconds: number | null
  receive_timezone: string | null
  receive_window_json: string | object | null
  next_due_at_utc: Date | null
  schedule_revision: number | null
}

const summary = (row: StrategyRow): StrategySummary => ({
  id: row.id, kind: row.kind, scope: row.scope, ownerUserId: row.owner_user_id, name: row.name,
  description: row.description, status: row.status, activeVersionId: row.active_version_id, revision: Number(row.revision),
})

export class MysqlStrategyCatalog implements StrategyCatalog, StrategyManagementRepository {
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

  async findDetail(userId: number, strategyId: string): Promise<StrategyDetail | null> {
    return readStrategyDetail(this.pool, userId, strategyId)
  }

  async create(input: CreateStrategyInput, prepare: () => PreparedStrategyDraft): Promise<StrategyDetail> {
    return createStrategyWithReceipt(this.pool, input, prepare, (connection, id) => readStrategyDetail(connection, input.userId, id))
  }

  async updateMetadata(input: UpdateStrategyMetadataInput, prepare: () => Pick<UpdateStrategyMetadataInput, 'name' | 'description'>): Promise<StrategyDetail> {
    return updateStrategyMetadataWithReceipt(this.pool, input, prepare, connection => readStrategyDetail(connection, input.userId, input.strategyId))
  }

  async createVersion(input: CreateStrategyVersionInput, prepare: (kind: StrategyKind) => StrategyCompileResult): Promise<StrategyDetail> {
    return createStrategyVersionWithReceipt(this.pool, input, prepare, connection => readStrategyDetail(connection, input.userId, input.strategyId))
  }

  async publishVersion(input: PublishStrategyVersionInput): Promise<StrategyDetail> {
    return publishStrategyVersionWithReceipt(this.pool, input, connection => readStrategyDetail(connection, input.userId, input.strategyId))
  }

  async retire(input: RetireStrategyInput): Promise<StrategyDetail> {
    return retireStrategyWithReceipt(this.pool, input, connection => readStrategyDetail(connection, input.userId, input.strategyId))
  }

  setAccountTrader(input: TraderControlInput) { return setAccountTrader(this.pool, input) }

  async listSubscriptions(userId: number, tradingAccountId?: string) {
    const params: Array<number | string> = [userId]
    const accountClause = tradingAccountId === undefined ? '' : ' AND s.trading_account_id=?'
    if (tradingAccountId !== undefined) params.push(tradingAccountId)
    const [rows] = await this.pool.execute<SubscriptionRow[]>(subscriptionSelect + ` WHERE s.user_id=?${accountClause} ORDER BY s.status,s.updated_at_utc DESC,s.id DESC`, params)
    return rows.map(subscription)
  }

  async findSubscription(userId: number, subscriptionId: string) {
    const [rows] = await this.pool.execute<SubscriptionRow[]>(subscriptionSelect + ' WHERE s.id=? AND s.user_id=? LIMIT 1', [subscriptionId, userId])
    const row = rows[0]
    return row ? subscription(row) : null
  }

  async createSubscription(raw: CreateStrategySubscriptionInput, prepare: () => PreparedSubscriptionCreate) {
    try {
      const { userId, idempotencyKey, ...fields } = raw
      const payload = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
      const outcome = await executeStrategyWrite(this.pool, { actorUserId: userId, idempotencyKey,
        action: 'create_subscription', targetId: raw.tradingAccountId, expectedRevision: null, payload }, async connection => {
        const input = { ...raw, ...prepare() }
        const strategies = await activeStrategies(connection, input.userId, [input.analysisStrategyId, ...(input.traderStrategyId ? [input.traderStrategyId] : [])], input.standardSymbol)
        const analysis = strategies.get(input.analysisStrategyId)
        if (!analysis || analysis.kind !== 'analysis') throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const trader = input.traderStrategyId ? strategies.get(input.traderStrategyId) : null
        if (input.traderStrategyId && (!trader || trader.kind !== 'trader')) throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const [duplicate] = await connection.execute<RowDataPacket[]>('SELECT id FROM strategy_subscriptions WHERE user_id=? AND trading_account_id=? AND analysis_strategy_id=? AND standard_symbol=? LIMIT 1 FOR UPDATE', [input.userId, input.tradingAccountId, input.analysisStrategyId, input.standardSymbol])
        if (duplicate[0]) throw new StrategyAccessError('strategy_subscription_exists', 409)
        if (input.status === 'active' && input.traderEnabled) {
          const [occupied] = await connection.execute<RowDataPacket[]>('SELECT id FROM strategy_subscriptions WHERE active_execution_key=? LIMIT 1 FOR UPDATE', [`${input.tradingAccountId}:${input.standardSymbol}`])
          if (occupied[0]) throw new StrategyAccessError('strategy_subscription_execution_conflict', 409)
        }
        const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO strategy_subscriptions (user_id,trading_account_id,standard_symbol,analysis_strategy_id,analysis_strategy_version_id,trader_strategy_id,trader_strategy_version_id,analysis_enabled,trader_enabled,trade_send_enabled,status,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [input.userId, input.tradingAccountId, input.standardSymbol, input.analysisStrategyId, analysis.activeVersionId, input.traderStrategyId, trader?.activeVersionId ?? null, input.analysisEnabled ? 1 : 0, input.traderEnabled ? 1 : 0, input.tradeSendEnabled ? 1 : 0, input.status])
        await connection.execute(`INSERT INTO subscription_schedules (subscription_id,cadence_seconds,receive_timezone,receive_window_json,next_due_at_utc,revision,updated_at_utc) VALUES (?,300,?,?,?,1,UTC_TIMESTAMP(3))`, [inserted.insertId, input.receiveTimezone, JSON.stringify(input.receiveWindow), input.nextDueAt === null ? null : strategySqlTime(input.nextDueAt)])
        await initializeSubscriptionExecutionPreferences(connection, String(inserted.insertId))
        const row = await selectSubscription(connection, input.userId, String(inserted.insertId), false)
        if (!row) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        const value = subscription(row)
        return { resourceId: value.id, revision: value.revision, value }
      }, (result): result is StrategyWriteResult<StrategySubscription> => {
        const item = result as StrategyWriteResult<StrategySubscription> | null
        return !!item && !!item.value && item.value.id === item.resourceId && item.revision === 1 && item.value.revision === 1
          && item.value.userId === raw.userId && item.value.tradingAccountId === raw.tradingAccountId
          && item.value.analysisStrategyId === raw.analysisStrategyId && !!item.value.schedule
      }, connection => ownedAccount(connection, raw.userId, raw.tradingAccountId))
      return outcome.value
    } catch (error) { throw translateSubscriptionError(error) }
  }

  async updateSubscription(input: UpdateStrategySubscriptionInput, prepare: (current: StrategySubscription) => PreparedSubscriptionUpdate) {
    try {
      let existing: SubscriptionRow | undefined
      const { userId, idempotencyKey, subscriptionId, expectedRevision, ...fields } = input
      const payload = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
      const outcome = await executeStrategyWrite(this.pool, { actorUserId: userId, idempotencyKey,
        action: 'update_subscription', targetId: subscriptionId, expectedRevision, payload }, async connection => {
        if (!existing) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        if (existing.status === 'ended') throw new StrategyAccessError('strategy_subscription_ended', 409)
        if (Number(existing.revision) !== expectedRevision || expectedRevision >= Number.MAX_SAFE_INTEGER) {
          throw new StrategyAccessError('strategy_subscription_revision_conflict', 412)
        }
        const analysisId = input.analysisStrategyId ?? existing.analysis_strategy_id
        const traderId = input.traderStrategyId === undefined ? existing.trader_strategy_id : input.traderStrategyId
        const analysisChanged = analysisId !== existing.analysis_strategy_id
        const traderChanged = traderId !== existing.trader_strategy_id
        const running = (input.status ?? existing.status) === 'active'
        const needsAnalysis = running && (input.analysisEnabled ?? Boolean(existing.analysis_enabled))
        const needsTrader = running && (input.traderEnabled ?? Boolean(existing.trader_enabled))
        const resolveAnalysis = analysisChanged || needsAnalysis
        const resolveTrader = traderId !== null && (traderChanged || needsTrader)
        const ids = [
          ...(resolveAnalysis || needsAnalysis ? [analysisId] : []),
          ...((resolveTrader || needsTrader) && traderId !== null ? [traderId] : []),
        ]
        const strategies = await activeStrategies(connection, input.userId, ids, input.standardSymbol ?? existing.standard_symbol)
        const analysis = resolveAnalysis ? strategies.get(analysisId) : null
        if (resolveAnalysis && (!analysis || analysis.kind !== 'analysis')) throw new StrategyAccessError(needsAnalysis ? 'strategy_subscription_strategy_unavailable' : 'strategy_kind_mismatch', needsAnalysis ? 409 : 422)
        const trader = resolveTrader ? strategies.get(traderId) : null
        if (resolveTrader && (!trader || trader.kind !== 'trader')) throw new StrategyAccessError(needsTrader ? 'strategy_subscription_strategy_unavailable' : 'strategy_kind_mismatch', needsTrader ? 409 : 422)
        const analysisVersionId = resolveAnalysis ? analysis?.activeVersionId ?? null : existing.analysis_strategy_version_id
        if (!analysisVersionId) throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const traderVersionId = resolveTrader ? trader?.activeVersionId ?? null : existing.trader_strategy_version_id
        const [rowLock] = await connection.execute<SubscriptionRow[]>(subscriptionSelect + ' WHERE s.id=? AND s.user_id=? LIMIT 1 FOR UPDATE', [input.subscriptionId, input.userId])
        const locked = rowLock[0]
        if (!locked) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        if (locked.status === 'ended') throw new StrategyAccessError('strategy_subscription_ended', 409)
        if (Number(locked.revision) !== expectedRevision || locked.trading_account_id !== existing.trading_account_id) {
          throw new StrategyAccessError('strategy_subscription_revision_conflict', 412)
        }
        const prepared = prepare(subscription(locked))
        const { analysisEnabled, traderEnabled, tradeSendEnabled, status } = prepared
        const symbol = prepared.standardSymbol
        if (status === 'active') {
          for (const [enabled, kind, id, versionId] of [
            [analysisEnabled, 'analysis', analysisId, analysisVersionId],
            [traderEnabled, 'trader', traderId, traderVersionId],
          ] as const) {
            if (!enabled) continue
            const current = id === null ? undefined : strategies.get(id)
            if (!current || current.kind !== kind || current.activeVersionId !== versionId) {
              throw new StrategyAccessError('strategy_subscription_strategy_unavailable', 409)
            }
          }
        }
        if (traderEnabled && (!traderId || !traderVersionId)) throw new StrategyAccessError('subscription_trader_required', 422)
        if (status === 'active' && traderEnabled) {
          const [occupied] = await connection.execute<RowDataPacket[]>('SELECT id FROM strategy_subscriptions WHERE active_execution_key=? AND id<>? LIMIT 1 FOR UPDATE', [`${existing.trading_account_id}:${symbol}`, input.subscriptionId])
          if (occupied[0]) throw new StrategyAccessError('strategy_subscription_execution_conflict', 409)
        }
        const traderFlag = traderEnabled ? 1 : 0
        const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategy_subscriptions SET standard_symbol=?,analysis_strategy_id=?,analysis_strategy_version_id=?,trader_strategy_id=?,trader_strategy_version_id=?,analysis_enabled=?,trader_enabled=?,trade_send_enabled=?,status=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND user_id=? AND revision=?`, [symbol, analysisId, analysisVersionId, traderId, traderVersionId, analysisEnabled ? 1 : 0, traderFlag, tradeSendEnabled ? 1 : 0, status, input.subscriptionId, input.userId, input.expectedRevision])
        if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_subscription_revision_conflict', 412)
        const [scheduleUpdated] = await connection.execute<ResultSetHeader>('UPDATE subscription_schedules SET receive_timezone=?,receive_window_json=?,next_due_at_utc=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE subscription_id=?', [prepared.receiveTimezone, JSON.stringify(prepared.receiveWindow), prepared.nextDueAt === null ? null : strategySqlTime(prepared.nextDueAt), input.subscriptionId])
        if (scheduleUpdated.affectedRows !== 1) throw new StrategyAccessError('strategy_subscription_schedule_missing', 503)
        const row = await selectSubscription(connection, input.userId, input.subscriptionId, false)
        if (!row) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        const value = subscription(row)
        return { resourceId: value.id, revision: value.revision, value }
      }, (result): result is StrategyWriteResult<StrategySubscription> => {
        const item = result as StrategyWriteResult<StrategySubscription> | null
        return !!item && !!item.value && item.resourceId === subscriptionId && item.value.id === subscriptionId
          && item.revision === expectedRevision + 1 && item.value.revision === item.revision && item.value.userId === userId
          && item.value.tradingAccountId === existing?.trading_account_id && !!item.value.schedule
      }, async connection => {
        const [rows] = await connection.execute<SubscriptionRow[]>(subscriptionSelect + ' WHERE s.id=? AND s.user_id=? LIMIT 1', [subscriptionId, userId])
        existing = rows[0]
        if (!existing) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        await ownedAccount(connection, userId, existing.trading_account_id)
      })
      return outcome.value
    } catch (error) { throw translateSubscriptionError(error) }
  }
}

const strategySelect = `SELECT CAST(s.id AS CHAR) id,s.kind,s.scope,s.owner_user_id,s.name,s.description,s.status,CAST(s.active_version_id AS CHAR) active_version_id,s.revision FROM strategies s`
const versionSelect = `SELECT CAST(v.id AS CHAR) id,CAST(v.strategy_id AS CHAR) strategy_id,s.kind,v.version_number,v.prompt_text,v.prompt_sha256,v.config_json,v.input_contract_version,v.output_contract_version,v.created_by_user_id,v.created_at_utc FROM strategy_versions v INNER JOIN strategies s ON s.id=v.strategy_id`
const subscriptionSelect = `SELECT CAST(s.id AS CHAR) id,s.user_id,CAST(s.trading_account_id AS CHAR) trading_account_id,s.standard_symbol,CAST(s.analysis_strategy_id AS CHAR) analysis_strategy_id,CAST(COALESCE((SELECT active_version_id FROM strategies WHERE id=s.analysis_strategy_id),s.analysis_strategy_version_id) AS CHAR) analysis_strategy_version_id,CAST(s.trader_strategy_id AS CHAR) trader_strategy_id,CAST(COALESCE((SELECT active_version_id FROM strategies WHERE id=s.trader_strategy_id),s.trader_strategy_version_id) AS CHAR) trader_strategy_version_id,s.analysis_enabled,s.trader_enabled,s.trade_send_enabled,s.status,s.revision,s.created_at_utc,s.updated_at_utc,COALESCE((SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(v.config_json,'$.interval_minutes')) AS UNSIGNED)*60 FROM strategy_versions v WHERE v.id=(SELECT active_version_id FROM strategies WHERE id=s.analysis_strategy_id)),sc.cadence_seconds) cadence_seconds,sc.receive_timezone,sc.receive_window_json,sc.next_due_at_utc,sc.revision schedule_revision FROM strategy_subscriptions s LEFT JOIN subscription_schedules sc ON sc.subscription_id=s.id INNER JOIN trading_account_ownerships owner ON owner.trading_account_id=s.trading_account_id AND owner.user_id=s.user_id AND owner.role='owner' AND owner.revoked_at_utc IS NULL`

export async function readStrategyDetail(reader: Pick<PoolConnection, 'execute'>, userId: number, strategyId: string): Promise<StrategyDetail | null> {
  const [rows] = await reader.execute<StrategyRow[]>(`${strategySelect} WHERE s.id=? AND s.deleted_at_utc IS NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1`, [strategyId, userId])
  const row = rows[0]
  if (!row) return null
  const [versions] = await reader.execute<VersionDetailRow[]>(versionSelect + ' WHERE v.strategy_id=? ORDER BY v.version_number DESC,v.id DESC', [strategyId])
  return { summary: summary(row), versions: versions.map(versionDetail) }
}

async function ownedAccount(connection: PoolConnection, userId: number, accountId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT a.id FROM trading_accounts a INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=? AND o.role=\'owner\' AND o.revoked_at_utc IS NULL WHERE a.id=? AND a.deleted_at_utc IS NULL LIMIT 1 FOR UPDATE', [userId, accountId])
  if (!rows[0]) throw new StrategyAccessError('strategy_account_forbidden', 403)
}

async function activeStrategies(connection: PoolConnection, userId: number, ids: string[], symbol: string) {
  const result = new Map<string, { id: string; kind: StrategyKind; activeVersionId: string }>()
  for (const id of [...new Set(ids)].sort()) {
    const [rows] = await connection.execute<(RowDataPacket & { id: string; kind: StrategyKind; active_version_id: string | null })[]>(`SELECT CAST(s.id AS CHAR) id,s.kind,CAST(s.active_version_id AS CHAR) active_version_id,(SELECT config_json FROM strategy_versions WHERE id=s.active_version_id AND strategy_id=s.id) config_json FROM strategies s WHERE s.id=? AND s.deleted_at_utc IS NULL AND s.status='active' AND s.active_version_id IS NOT NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1 FOR SHARE`, [id, userId])
    const row = rows[0]
    if (row?.active_version_id) assertStrategySymbol(parseConfig(row.config_json ?? {}), symbol)
    if (row?.active_version_id) result.set(id, { id, kind: row.kind, activeVersionId: row.active_version_id })
  }
  return result
}

async function selectSubscription(connection: PoolConnection, userId: number, subscriptionId: string, forUpdate: boolean) {
  const [rows] = await connection.execute<SubscriptionRow[]>(`${subscriptionSelect} WHERE s.id=? AND s.user_id=? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [subscriptionId, userId])
  return rows[0] ?? null
}

function versionDetail(row: VersionDetailRow) {
  return {
    id: row.id, strategyId: row.strategy_id, kind: row.kind, version: Number(row.version_number), promptText: row.prompt_text,
    promptHash: row.prompt_sha256, config: parseConfig(row.config_json), inputContractVersion: row.input_contract_version,
    outputContractVersion: row.output_contract_version, createdByUserId: Number(row.created_by_user_id), createdAt: toIso(row.created_at_utc),
  }
}

function subscription(row: SubscriptionRow): StrategySubscription {
  return {
    id: row.id, userId: Number(row.user_id), tradingAccountId: row.trading_account_id, standardSymbol: row.standard_symbol,
    analysisStrategyId: row.analysis_strategy_id, analysisStrategyVersionId: row.analysis_strategy_version_id,
    traderStrategyId: row.trader_strategy_id, traderStrategyVersionId: row.trader_strategy_version_id,
    analysisEnabled: Boolean(row.analysis_enabled), traderEnabled: Boolean(row.trader_enabled), tradeSendEnabled: Boolean(row.trader_enabled),
    status: row.status, revision: Number(row.revision), createdAt: toIso(row.created_at_utc), updatedAt: toIso(row.updated_at_utc),
    schedule: {
      cadenceSeconds: Number(row.cadence_seconds ?? 300), receiveTimezone: row.receive_timezone ?? 'UTC',
      receiveWindow: parseConfig(row.receive_window_json ?? { enabled: false }), nextDueAt: row.next_due_at_utc ? toIso(row.next_due_at_utc) : null,
      revision: Number(row.schedule_revision ?? 1),
    },
  }
}

const toIso = strategyIsoTime

function translateSubscriptionError(error: unknown): unknown {
  if (error instanceof StrategyAccessError) return error
  const code = (error as { code?: string }).code
  if (code === 'ER_DUP_ENTRY') return new StrategyAccessError('strategy_subscription_conflict', 409)
  return error
}

function parseConfig(value: string | object) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
