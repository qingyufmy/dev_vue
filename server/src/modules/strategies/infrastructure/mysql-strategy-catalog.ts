import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { StrategyCatalog, StrategyManagementRepository } from '../application/strategy-service.js'
import type {
  CreateStrategyInput, CreateStrategySubscriptionInput, CreateStrategyVersionInput, PublishStrategyVersionInput,
  RetireStrategyInput, StrategyCompileResult, StrategyDetail, StrategyKind, StrategySubscription, StrategySummary, StrategyVersion,
  UpdateStrategyMetadataInput, UpdateStrategySubscriptionInput,
} from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
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
    const [rows] = await this.pool.execute<StrategyRow[]>(`${strategySelect} WHERE s.id=? AND s.deleted_at_utc IS NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1`, [strategyId, userId])
    const row = rows[0]
    if (!row) return null
    const [versions] = await this.pool.execute<VersionDetailRow[]>(versionSelect + ' WHERE v.strategy_id=? ORDER BY v.version_number DESC,v.id DESC', [strategyId])
    return { summary: summary(row), versions: versions.map(versionDetail) }
  }

  async create(input: CreateStrategyInput & { compiled: StrategyCompileResult }): Promise<StrategyDetail> {
    const strategyId = await transaction(this.pool, async connection => {
      const now = 'UTC_TIMESTAMP(3)'
      const [strategy] = await connection.execute<ResultSetHeader>(`INSERT INTO strategies (kind,scope,owner_user_id,name,description,status,revision,created_at_utc,updated_at_utc) VALUES (?, 'user', ?, ?, ?, 'draft', 1, ${now}, ${now})`, [input.kind, input.userId, input.name, input.description])
      await connection.execute(`INSERT INTO strategy_versions (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc) VALUES (?,1,?,?,?,?,?,?,${now})`, [strategy.insertId, input.promptText, input.compiled.promptHash, input.compiled.inputContractVersion, input.compiled.outputContractVersion, JSON.stringify(input.compiled.normalizedConfig), input.userId])
      return String(strategy.insertId)
    })
    const detail = await this.findDetail(input.userId, strategyId)
    if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
    return detail
  }

  async updateMetadata(input: UpdateStrategyMetadataInput): Promise<StrategyDetail> {
    await transaction(this.pool, async connection => {
      const row = await visibleStrategy(connection, input.userId, input.strategyId, true)
      if (!row) throw new StrategyAccessError('strategy_not_found', 404)
      if (row.scope !== 'user' || row.owner_user_id !== input.userId) throw new StrategyAccessError('strategy_read_only', 403)
      if (row.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategies SET name=?,description=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?`, [input.name, input.description, input.strategyId, input.userId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
    })
    const detail = await this.findDetail(input.userId, input.strategyId)
    if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
    return detail
  }

  async createVersion(input: CreateStrategyVersionInput): Promise<StrategyDetail> {
    await transaction(this.pool, async connection => {
      const row = await visibleStrategy(connection, input.userId, input.strategyId, true)
      if (!row) throw new StrategyAccessError('strategy_not_found', 404)
      if (row.scope !== 'user' || row.owner_user_id !== input.userId) throw new StrategyAccessError('strategy_read_only', 403)
      if (row.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
      const [numberRows] = await connection.execute<(RowDataPacket & { next_version: number })[]>('SELECT COALESCE(MAX(version_number),0)+1 next_version FROM strategy_versions WHERE strategy_id=?', [input.strategyId])
      const nextVersion = Number(numberRows[0]?.next_version ?? 1)
      await connection.execute(`INSERT INTO strategy_versions (strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc) VALUES (?,?,?,?,?,?,?, ?,UTC_TIMESTAMP(3))`, [input.strategyId, nextVersion, input.promptText, input.compiled.promptHash, input.compiled.inputContractVersion, input.compiled.outputContractVersion, JSON.stringify(input.compiled.normalizedConfig), input.userId])
      const [updated] = await connection.execute<ResultSetHeader>('UPDATE strategies SET revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope=\'user\' AND revision=?', [input.strategyId, input.userId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
    })
    const detail = await this.findDetail(input.userId, input.strategyId)
    if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
    return detail
  }

  async publishVersion(input: PublishStrategyVersionInput): Promise<StrategyDetail> {
    await transaction(this.pool, async connection => {
      const row = await visibleStrategy(connection, input.userId, input.strategyId, true)
      if (!row) throw new StrategyAccessError('strategy_not_found', 404)
      if (row.scope !== 'user' || row.owner_user_id !== input.userId) throw new StrategyAccessError('strategy_read_only', 403)
      if (row.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
      const [versionRows] = await connection.execute<VersionRow[]>('SELECT CAST(v.id AS CHAR) id,CAST(v.strategy_id AS CHAR) strategy_id,s.kind,v.version_number,v.prompt_text,v.prompt_sha256,v.config_json,v.input_contract_version,v.output_contract_version FROM strategy_versions v INNER JOIN strategies s ON s.id=v.strategy_id WHERE v.id=? AND v.strategy_id=? LIMIT 1', [input.versionId, input.strategyId])
      const version = versionRows[0]
      if (!version) throw new StrategyAccessError('strategy_version_not_found', 404)
      if (version.kind !== row.kind) throw new StrategyAccessError('strategy_kind_mismatch', 422)
      await rebindPublishedVersion(connection, input.userId, input.strategyId, input.versionId)
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategies SET active_version_id=?,status='active',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?`, [input.versionId, input.strategyId, input.userId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
    })
    const detail = await this.findDetail(input.userId, input.strategyId)
    if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
    return detail
  }

  async retire(input: RetireStrategyInput): Promise<StrategyDetail> {
    await transaction(this.pool, async connection => {
      const row = await visibleStrategy(connection, input.userId, input.strategyId, true)
      if (!row) throw new StrategyAccessError('strategy_not_found', 404)
      if (row.scope !== 'user' || row.owner_user_id !== input.userId) throw new StrategyAccessError('strategy_read_only', 403)
      if (row.status === 'retired') throw new StrategyAccessError('strategy_retired', 409)
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategies SET status='retired',revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND owner_user_id=? AND scope='user' AND revision=?`, [input.strategyId, input.userId, input.expectedRevision])
      if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_revision_conflict', 412)
    })
    const detail = await this.findDetail(input.userId, input.strategyId)
    if (!detail) throw new StrategyAccessError('strategy_not_found', 404)
    return detail
  }

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

  async createSubscription(input: CreateStrategySubscriptionInput) {
    try {
      return await transaction(this.pool, async connection => {
        await ownedAccount(connection, input.userId, input.tradingAccountId)
        const strategies = await activeStrategies(connection, input.userId, [input.analysisStrategyId, ...(input.traderStrategyId ? [input.traderStrategyId] : [])])
        const analysis = strategies.get(input.analysisStrategyId)
        if (!analysis || analysis.kind !== 'analysis') throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const trader = input.traderStrategyId ? strategies.get(input.traderStrategyId) : null
        if (input.traderEnabled && (!trader || trader.kind !== 'trader')) throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const [duplicate] = await connection.execute<RowDataPacket[]>('SELECT id FROM strategy_subscriptions WHERE user_id=? AND trading_account_id=? AND analysis_strategy_id=? AND standard_symbol=? LIMIT 1 FOR UPDATE', [input.userId, input.tradingAccountId, input.analysisStrategyId, input.standardSymbol])
        if (duplicate[0]) throw new StrategyAccessError('strategy_subscription_exists', 409)
        if (input.status === 'active' && input.traderEnabled) {
          const [occupied] = await connection.execute<RowDataPacket[]>('SELECT id FROM strategy_subscriptions WHERE active_execution_key=? LIMIT 1 FOR UPDATE', [`${input.tradingAccountId}:${input.standardSymbol}`])
          if (occupied[0]) throw new StrategyAccessError('strategy_subscription_execution_conflict', 409)
        }
        const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO strategy_subscriptions (user_id,trading_account_id,standard_symbol,analysis_strategy_id,analysis_strategy_version_id,trader_strategy_id,trader_strategy_version_id,analysis_enabled,trader_enabled,trade_send_enabled,status,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [input.userId, input.tradingAccountId, input.standardSymbol, input.analysisStrategyId, analysis.activeVersionId, input.traderStrategyId, trader?.activeVersionId ?? null, input.analysisEnabled ? 1 : 0, input.traderEnabled ? 1 : 0, input.tradeSendEnabled ? 1 : 0, input.status])
        await connection.execute(`INSERT INTO subscription_schedules (subscription_id,cadence_seconds,receive_timezone,receive_window_json,next_due_at_utc,revision,updated_at_utc) VALUES (?,300,'UTC','{"enabled":false}',?,1,UTC_TIMESTAMP(3))`, [inserted.insertId, input.nextDueAt])
        await initializeSubscriptionExecutionPreferences(connection, String(inserted.insertId))
        const row = await selectSubscription(connection, input.userId, String(inserted.insertId), false)
        if (!row) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        return subscription(row)
      })
    } catch (error) { throw translateSubscriptionError(error) }
  }

  async updateSubscription(input: UpdateStrategySubscriptionInput) {
    try {
      return await transaction(this.pool, async connection => {
        const [unlocked] = await connection.execute<SubscriptionRow[]>(subscriptionSelect + ' WHERE s.id=? AND s.user_id=? LIMIT 1', [input.subscriptionId, input.userId])
        const existing = unlocked[0]
        if (!existing) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        if (existing.status === 'ended') throw new StrategyAccessError('strategy_subscription_ended', 409)
        await ownedAccount(connection, input.userId, existing.trading_account_id)
        const analysisId = input.analysisStrategyId ?? existing.analysis_strategy_id
        const traderId = input.traderStrategyId === undefined ? existing.trader_strategy_id : input.traderStrategyId
        const analysisChanged = analysisId !== existing.analysis_strategy_id
        const traderChanged = traderId !== existing.trader_strategy_id
        const resolveAnalysis = analysisChanged || input.analysisStrategyVersionId !== undefined
        const resolveTrader = traderId !== null && (traderChanged || input.traderStrategyVersionId !== undefined)
        const ids = [
          ...(resolveAnalysis ? [analysisId] : []),
          ...(resolveTrader ? [traderId] : []),
        ]
        const strategies = await activeStrategies(connection, input.userId, ids)
        const analysis = resolveAnalysis ? strategies.get(analysisId) : null
        if (resolveAnalysis && (!analysis || analysis.kind !== 'analysis')) throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const trader = resolveTrader ? strategies.get(traderId) : null
        if (resolveTrader && (!trader || trader.kind !== 'trader')) throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const analysisVersionId = input.analysisStrategyVersionId ?? (analysisChanged ? analysis?.activeVersionId ?? null : existing.analysis_strategy_version_id)
        if (!analysisVersionId) throw new StrategyAccessError('strategy_kind_mismatch', 422)
        const traderVersionId = input.traderStrategyVersionId === undefined
          ? (traderChanged ? trader?.activeVersionId ?? null : existing.trader_strategy_version_id)
          : input.traderStrategyVersionId
        const [rowLock] = await connection.execute<SubscriptionRow[]>(subscriptionSelect + ' WHERE s.id=? AND s.user_id=? LIMIT 1 FOR UPDATE', [input.subscriptionId, input.userId])
        const locked = rowLock[0]
        if (!locked) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        if (locked.status === 'ended') throw new StrategyAccessError('strategy_subscription_ended', 409)
        const symbol = input.standardSymbol ?? locked.standard_symbol
        const analysisEnabled = input.analysisEnabled ?? locked.analysis_enabled === 1
        const traderEnabled = input.traderEnabled ?? locked.trader_enabled === 1
        const tradeSendEnabled = input.tradeSendEnabled ?? locked.trade_send_enabled === 1
        const status = input.status ?? locked.status
        if (traderEnabled && (!traderId || !traderVersionId)) throw new StrategyAccessError('subscription_trader_required', 422)
        if (status === 'active' && traderEnabled) {
          const [occupied] = await connection.execute<RowDataPacket[]>('SELECT id FROM strategy_subscriptions WHERE active_execution_key=? AND id<>? LIMIT 1 FOR UPDATE', [`${existing.trading_account_id}:${symbol}`, input.subscriptionId])
          if (occupied[0]) throw new StrategyAccessError('strategy_subscription_execution_conflict', 409)
        }
        const traderFlag = traderEnabled ? 1 : 0
        const [updated] = await connection.execute<ResultSetHeader>(`UPDATE strategy_subscriptions SET standard_symbol=?,analysis_strategy_id=?,analysis_strategy_version_id=?,trader_strategy_id=?,trader_strategy_version_id=?,analysis_enabled=?,trader_enabled=?,trade_send_enabled=?,status=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND user_id=? AND revision=?`, [symbol, analysisId, analysisVersionId, traderId, traderVersionId, analysisEnabled ? 1 : 0, traderFlag, tradeSendEnabled ? 1 : 0, status, input.subscriptionId, input.userId, input.expectedRevision])
        if (updated.affectedRows !== 1) throw new StrategyAccessError('strategy_subscription_revision_conflict', 412)
        await connection.execute('UPDATE subscription_schedules SET next_due_at_utc=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE subscription_id=?', [input.nextDueAt, input.subscriptionId])
        const row = await selectSubscription(connection, input.userId, input.subscriptionId, false)
        if (!row) throw new StrategyAccessError('strategy_subscription_not_found', 404)
        return subscription(row)
      })
    } catch (error) { throw translateSubscriptionError(error) }
  }
}

const strategySelect = `SELECT CAST(s.id AS CHAR) id,s.kind,s.scope,s.owner_user_id,s.name,s.description,s.status,CAST(s.active_version_id AS CHAR) active_version_id,s.revision FROM strategies s`
const versionSelect = `SELECT CAST(v.id AS CHAR) id,CAST(v.strategy_id AS CHAR) strategy_id,s.kind,v.version_number,v.prompt_text,v.prompt_sha256,v.config_json,v.input_contract_version,v.output_contract_version,v.created_by_user_id,v.created_at_utc FROM strategy_versions v INNER JOIN strategies s ON s.id=v.strategy_id`
const subscriptionSelect = `SELECT CAST(s.id AS CHAR) id,s.user_id,CAST(s.trading_account_id AS CHAR) trading_account_id,s.standard_symbol,CAST(s.analysis_strategy_id AS CHAR) analysis_strategy_id,CAST(s.analysis_strategy_version_id AS CHAR) analysis_strategy_version_id,CAST(s.trader_strategy_id AS CHAR) trader_strategy_id,CAST(s.trader_strategy_version_id AS CHAR) trader_strategy_version_id,s.analysis_enabled,s.trader_enabled,s.trade_send_enabled,s.status,s.revision,s.created_at_utc,s.updated_at_utc,sc.cadence_seconds,sc.receive_timezone,sc.receive_window_json,sc.next_due_at_utc,sc.revision schedule_revision FROM strategy_subscriptions s LEFT JOIN subscription_schedules sc ON sc.subscription_id=s.id INNER JOIN trading_account_ownerships owner ON owner.trading_account_id=s.trading_account_id AND owner.user_id=s.user_id AND owner.role='owner' AND owner.revoked_at_utc IS NULL`

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const value = await work(connection); await connection.commit(); return value }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}

async function visibleStrategy(connection: PoolConnection, userId: number, strategyId: string, forUpdate: boolean) {
  const [rows] = await connection.execute<StrategyRow[]>(`${strategySelect} WHERE s.id=? AND s.deleted_at_utc IS NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [strategyId, userId])
  return rows[0] ?? null
}

async function ownedAccount(connection: PoolConnection, userId: number, accountId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT a.id FROM trading_accounts a INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=? AND o.role=\'owner\' AND o.revoked_at_utc IS NULL WHERE a.id=? AND a.deleted_at_utc IS NULL LIMIT 1 FOR UPDATE', [userId, accountId])
  if (!rows[0]) throw new StrategyAccessError('strategy_account_forbidden', 403)
}

async function activeStrategies(connection: PoolConnection, userId: number, ids: string[]) {
  const result = new Map<string, { id: string; kind: StrategyKind; activeVersionId: string }>()
  for (const id of [...new Set(ids)].sort()) {
    const [rows] = await connection.execute<(RowDataPacket & { id: string; kind: StrategyKind; active_version_id: string | null })[]>(`SELECT CAST(s.id AS CHAR) id,s.kind,CAST(s.active_version_id AS CHAR) active_version_id FROM strategies s WHERE s.id=? AND s.deleted_at_utc IS NULL AND s.status='active' AND s.active_version_id IS NOT NULL AND (s.scope='platform' OR s.owner_user_id=?) LIMIT 1 FOR SHARE`, [id, userId])
    const row = rows[0]
    if (row?.active_version_id) result.set(id, { id, kind: row.kind, activeVersionId: row.active_version_id })
  }
  return result
}

async function selectSubscription(connection: PoolConnection, userId: number, subscriptionId: string, forUpdate: boolean) {
  const [rows] = await connection.execute<SubscriptionRow[]>(`${subscriptionSelect} WHERE s.id=? AND s.user_id=? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [subscriptionId, userId])
  return rows[0] ?? null
}

async function rebindPublishedVersion(connection: PoolConnection, userId: number, strategyId: string, versionId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM strategy_subscriptions WHERE user_id=? AND status<>'ended' AND ((analysis_strategy_id=? AND analysis_strategy_version_id<>?) OR (trader_strategy_id=? AND (trader_strategy_version_id IS NULL OR trader_strategy_version_id<>?))) ORDER BY id FOR UPDATE`, [userId, strategyId, versionId, strategyId, versionId])
  const ids = rows.map(row => row.id)
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  await connection.execute<ResultSetHeader>(`UPDATE strategy_subscriptions SET analysis_strategy_version_id=CASE WHEN analysis_strategy_id=? THEN ? ELSE analysis_strategy_version_id END,trader_strategy_version_id=CASE WHEN trader_strategy_id=? THEN ? ELSE trader_strategy_version_id END,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id IN (${placeholders})`, [strategyId, versionId, strategyId, versionId, ...ids])
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
    analysisEnabled: Boolean(row.analysis_enabled), traderEnabled: Boolean(row.trader_enabled), tradeSendEnabled: Boolean(row.trade_send_enabled),
    status: row.status, revision: Number(row.revision), createdAt: toIso(row.created_at_utc), updatedAt: toIso(row.updated_at_utc),
    schedule: {
      cadenceSeconds: Number(row.cadence_seconds ?? 300), receiveTimezone: row.receive_timezone ?? 'UTC',
      receiveWindow: parseConfig(row.receive_window_json ?? { enabled: false }), nextDueAt: row.next_due_at_utc ? toIso(row.next_due_at_utc) : null,
      revision: Number(row.schedule_revision ?? 1),
    },
  }
}

function toIso(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString() }

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
