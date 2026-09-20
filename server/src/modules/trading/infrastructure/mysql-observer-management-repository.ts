import type { AnalysisStrategyAccess } from '../../strategies/index.js'
import type { AdminPrincipalAccess, ActivePrincipalAccess } from '../../auth/index.js'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import {
  ObserverManagementError,
  type ObserverChannelConfig,
  type ObserverManagementCommand,
  type ObserverManagementList,
  type ObserverManagementPage,
  type ObserverManagementRepository,
  type ObserverManagementResult,
  type ObserverManagementWrite,
  type ObserverSourceConfig,
} from '../application/observer-management-ports.js'
import {
  cursorForRow,
  cursorStart,
  insertedId,
  managementError,
  normalizeList,
  nullableId,
  parseAudit,
  parseResult,
  toIso,
  toRevision,
  toSafeUserId,
  validateActor,
  validateChannelConfig,
  validateExpectedRevision,
  validateId,
  validateSourceConfig,
  validateUserId,
  validateWrite,
} from './mysql-observer-management-values.js'

type Executor = Pick<Pool, 'execute'> | PoolConnection

interface RegistryRow extends RowDataPacket { revision: number | string }
interface ReceiptRow extends RowDataPacket {
  id: string
  actor_user_id: number | string
  idempotency_key: string
  request_hash: string
  action: string
  target_id: string
  result_json: string | Record<string, unknown>
  created_at_utc: Date | string
}
interface SourceRow extends RowDataPacket {
  id: string | number
  display_name: string
  notes: string | null
  operator_user_id: number | string
  trading_account_id: string | number | null
  analysis_strategy_id: string | number | null
  status: 'active' | 'disabled' | string
  configuration_status: 'pending' | 'ready' | string
  created_by_user_id: number | string
  created_at_utc: Date | string
  updated_at_utc: Date | string
  revision: number | string
}
interface ChannelRow extends RowDataPacket {
  id: string | number
  source_id: string | number | null
  source_trading_account_id: string | number | null
  display_name: string
  slug: string | null
  description: string | null
  audience: ObserverChannelConfig['audience'] | string
  active: number | boolean
  is_default: number | boolean
  sort_order: number | string
  created_at_utc: Date | string
  updated_at_utc: Date | string | null
  revision: number | string
  source_status?: string | null
  source_configuration_status?: string | null
  source_operator_user_id?: number | string | null
}
interface AccessRow extends RowDataPacket {
  observer_channel_id: string | number
  user_id: number | string
  granted_at_utc: Date | string
  revoked_at_utc: Date | string | null
  granted_by_user_id: number | string | null
  revision: number | string
}
interface OperationRow extends RowDataPacket {
  id: string
  action: string
  actor_user_id: number | string
  target_id: string
  result_json: string | Record<string, unknown>
  audit_json: string | Record<string, unknown> | null
  created_at_utc: Date | string
}
interface CommandEffect {
  targetId: string
  revision: number
  sourceId: string | null
  channelId: string | null
  userId: number | null
}

interface EventDimensions {
  sourceId: string | null
  channelId: string | null
  userId: number | null
}

const SOURCE_COLUMNS = `CAST(s.id AS CHAR) id,s.display_name,s.notes,s.operator_user_id,
  CAST(s.trading_account_id AS CHAR) trading_account_id,CAST(s.analysis_strategy_id AS CHAR) analysis_strategy_id,
  s.status,s.configuration_status,s.created_by_user_id,s.created_at_utc,s.updated_at_utc,s.revision`
const CHANNEL_COLUMNS = `CAST(c.id AS CHAR) id,CAST(c.source_id AS CHAR) source_id,
  CAST(c.source_trading_account_id AS CHAR) source_trading_account_id,c.display_name,c.slug,c.description,c.audience,
  c.active,c.is_default,c.sort_order,c.created_at_utc,c.updated_at_utc,c.revision`
const ACCESS_COLUMNS = `CAST(x.observer_channel_id AS CHAR) observer_channel_id,x.user_id,x.granted_at_utc,
  x.revoked_at_utc,x.granted_by_user_id,x.revision`

/**
 * The observer management boundary owns low-frequency administrative writes.
 *
 * Every write takes the registry row first.  This deliberately serializes the
 * small management surface and gives the outbox event one monotonic revision;
 * it also keeps this transaction's lock order ahead of the trading context
 * (which is never touched here).
 */
export class MysqlObserverManagementRepository implements ObserverManagementRepository {
  constructor(
    private readonly pool: Pool,
    private readonly administrators: (executor: Pick<PoolConnection, 'execute'>) => AdminPrincipalAccess,
    private readonly principalAccess: (connection: PoolConnection) => ActivePrincipalAccess,
    private readonly strategyAccess: (connection: PoolConnection) => AnalysisStrategyAccess,
  ) {}

  async list(actorUserId: number, input: ObserverManagementList): Promise<ObserverManagementPage> {
    validateActor(actorUserId)
    const normalized = normalizeList(input)
    try {
      await assertAdmin(this.administrators(this.pool), actorUserId, 'none')
      const registryRevision = await readRegistryRevision(this.pool)
      const rows = await this.listRows(this.pool, normalized)
      const hasMore = rows.length > normalized.limit
      const items = rows.slice(0, normalized.limit).map(row => mapListItem(normalized.kind, row))
      const nextCursor = hasMore && items.length > 0
        ? cursorForRow(normalized, rows[normalized.limit - 1]!)
        : null
      return { items, next_cursor: nextCursor, registry_revision: registryRevision }
    } catch (error) {
      if (error instanceof ObserverManagementError) throw error
      throw translateStorageError(error)
    }
  }

  async execute(input: ObserverManagementWrite): Promise<ObserverManagementResult> {
    validateWrite(input)
    return transaction(this.pool, async connection => {
      const registry = await lockRegistry(connection)
      await assertAdmin(this.administrators(connection), input.actorUserId, 'share')

      const receipt = await findReceipt(connection, input.actorUserId, input.idempotencyKey)
      if (receipt) {
        if (receipt.request_hash !== input.requestHash) throw managementError('observer_management_idempotency_conflict', 409)
        return parseResult(receipt.result_json)
      }

      const effect = await executeCommand(this.strategyAccess(connection), this.principalAccess(connection), connection, input.actorUserId, input.command, registry.revision)
      // Entity revisions are persisted as BIGINT values but exposed as safe
      // JavaScript integers.  Validate the command result before bumping the
      // global registry or writing its receipt/event so an invalid projection
      // can never escape this transaction.
      const effectRevision = toRevision(effect.revision)
      const registryRevision = await bumpRegistry(connection, registry.revision)
      const result: ObserverManagementResult = {
        operation_id: randomUUID(),
        target_id: effect.targetId,
        revision: effectRevision,
        registry_revision: registryRevision,
      }
      await connection.execute(
        `INSERT INTO observer_management_operations
          (id,actor_user_id,idempotency_key,request_hash,action,target_id,result_json,audit_json,created_at_utc)
         VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
        [result.operation_id, input.actorUserId, input.idempotencyKey, input.requestHash,
          input.command.kind, result.target_id, JSON.stringify(result), JSON.stringify(input.command)],
      )
      await writeAuthorizationInvalidation(connection, result.operation_id, dimensions(input.command, effect), registryRevision)
      return result
    })
  }

  private async listRows(executor: Executor, input: ObserverManagementList): Promise<RowDataPacket[]> {
    const afterId = input.afterId ?? cursorStart(input.kind)
    const limit = input.limit + 1
    if (input.kind === 'sources') {
      const [rows] = await executor.execute<SourceRow[]>(`SELECT ${SOURCE_COLUMNS}
        FROM observer_sources s WHERE s.id>? ORDER BY s.id LIMIT ?`, [afterId, limit])
      return rows
    }
    if (input.kind === 'channels') {
      const [rows] = await executor.execute<ChannelRow[]>(`SELECT ${CHANNEL_COLUMNS}
        FROM observer_channels c WHERE c.id>? ORDER BY c.id LIMIT ?`, [afterId, limit])
      return rows
    }
    if (input.kind === 'accesses') {
      if (input.channelId === undefined) throw managementError('observer_management_access_channel_required', 400)
      const [rows] = await executor.execute<AccessRow[]>(`SELECT ${ACCESS_COLUMNS}
        FROM observer_channel_accesses x WHERE x.observer_channel_id=? AND x.user_id>?
        ORDER BY x.user_id LIMIT ?`, [input.channelId, afterId, limit])
      return rows
    }
    const [rows] = await executor.execute<OperationRow[]>(`SELECT o.id,o.action,o.actor_user_id,o.target_id,o.result_json,o.audit_json,o.created_at_utc
      FROM observer_management_operations o WHERE o.id>? ORDER BY o.id LIMIT ?`, [afterId, limit])
    return rows
  }
}

async function executeCommand(strategies: AnalysisStrategyAccess, principals: ActivePrincipalAccess, executor: PoolConnection, actorUserId: number, command: ObserverManagementCommand, registryRevision: number): Promise<CommandEffect> {
  switch (command.kind) {
    case 'source.create': return createSource(strategies, principals, executor, actorUserId, command.config)
    case 'source.update': return updateSource(strategies, principals, executor, actorUserId, command.id, command.expectedRevision, command.config)
    case 'channel.create': return createChannel(executor, actorUserId, command.config)
    case 'channel.update': return updateChannel(principals, executor, actorUserId, command.id, command.expectedRevision, command.config)
    case 'channel.default': return setDefaultChannel(principals, executor, command.channelId, command.expectedRevision, registryRevision)
    case 'access.set': return setChannelAccess(principals, executor, actorUserId, command.channelId, command.userId, command.granted, command.expectedRevision)
  }
}

async function createSource(strategies: AnalysisStrategyAccess, principals: ActivePrincipalAccess, executor: PoolConnection, actorUserId: number, config: ObserverSourceConfig): Promise<CommandEffect> {
  validateSourceConfig(config)
  if (config.status !== 'disabled') throw managementError('observer_source_activation_requires_update', 409)
  if (config.tradingAccountId) await assertOwnedAccount(principals, executor, actorUserId, config.tradingAccountId)
  if (config.analysisStrategyId) await assertAnalysisStrategy(strategies, actorUserId, config.analysisStrategyId)

  // Creation is intentionally a safe two-step operation.  A newly-created
  // source cannot publish until an explicit source.update has passed the full
  // readiness checks.
  const [inserted] = await executor.execute<ResultSetHeader>(`INSERT INTO observer_sources
    (display_name,notes,operator_user_id,trading_account_id,analysis_strategy_id,status,configuration_status,
      created_by_user_id,created_at_utc,updated_at_utc,revision)
    VALUES (?,?,?,?,?,'disabled','pending',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1)`, [
    config.displayName, config.notes, actorUserId, config.tradingAccountId, config.analysisStrategyId, actorUserId,
  ])
  const sourceId = insertedId(inserted)
  return { targetId: sourceId, revision: 1, sourceId, channelId: null, userId: null }
}

async function updateSource(
  strategies: AnalysisStrategyAccess,
  principals: ActivePrincipalAccess,
  executor: PoolConnection,
  _actorUserId: number,
  sourceId: string,
  expectedRevision: number,
  config: ObserverSourceConfig,
): Promise<CommandEffect> {
  validateId(sourceId, 'observer_source_id_invalid')
  validateExpectedRevision(expectedRevision, false)
  validateSourceConfig(config)
  const existing = await selectSource(executor, sourceId, true)
  if (!existing) throw managementError('observer_source_not_found', 404)
  const operatorUserId = toSafeUserId(existing.operator_user_id)
  const existingRevision = toRevision(existing.revision)
  if (existingRevision !== expectedRevision) throw managementError('observer_source_revision_conflict', 409)
  const nextRevision = nextEntityRevision(existingRevision, 'observer_source_revision_conflict')

  const previousAccount = nullableId(existing.trading_account_id)
  const previousStrategy = nullableId(existing.analysis_strategy_id)
  if (config.tradingAccountId && (config.status === 'active' || config.tradingAccountId !== previousAccount)) {
    await assertOwnedAccount(principals, executor, operatorUserId, config.tradingAccountId)
  }
  if (config.analysisStrategyId && (config.status === 'active' || config.analysisStrategyId !== previousStrategy)) {
    await assertAnalysisStrategy(strategies, operatorUserId, config.analysisStrategyId)
  }
  if (config.status === 'active' && !config.tradingAccountId) throw managementError('observer_source_not_ready', 409)

  const configurationStatus = config.tradingAccountId ? 'ready' : 'pending'
  const [updated] = await executor.execute<ResultSetHeader>(`UPDATE observer_sources SET
      display_name=?,notes=?,trading_account_id=?,analysis_strategy_id=?,status=?,configuration_status=?,
      updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
    WHERE id=? AND revision=?`, [
    config.displayName, config.notes, config.tradingAccountId, config.analysisStrategyId, config.status,
    configurationStatus, sourceId, expectedRevision,
  ])
  if (updated.affectedRows !== 1) throw managementError('observer_source_revision_conflict', 409)

  if (previousAccount !== config.tradingAccountId) {
    await executor.execute(`UPDATE observer_channels SET source_trading_account_id=?,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
      WHERE source_id=?`, [config.tradingAccountId, sourceId])
  }
  if (config.status === 'disabled') {
    await executor.execute(`UPDATE observer_channels SET is_default=0,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
      WHERE source_id=? AND is_default=1`, [sourceId])
  }
  return { targetId: sourceId, revision: nextRevision, sourceId, channelId: null, userId: null }
}

async function createChannel(executor: PoolConnection, _actorUserId: number, config: ObserverChannelConfig): Promise<CommandEffect> {
  validateChannelConfig(config)
  const source = config.sourceId ? await selectSourceForChannel(executor, config.sourceId, true) : null
  if (config.sourceId && !source) throw managementError('observer_source_not_found', 404)
  if (config.active) throw managementError('observer_channel_activation_requires_update', 409)
  const accountId = source ? nullableId(source.trading_account_id) : null
  const [inserted] = await executor.execute<ResultSetHeader>(`INSERT INTO observer_channels
    (source_trading_account_id,display_name,active,created_by_user_id,created_at_utc,source_id,slug,description,
      audience,is_default,sort_order,updated_at_utc,revision)
    VALUES (?, ?, 0, ?, UTC_TIMESTAMP(3), ?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(3), 1)`, [
    accountId, config.displayName, _actorUserId, config.sourceId, config.slug, config.description, config.audience, config.sortOrder,
  ])
  const channelId = insertedId(inserted)
  return { targetId: channelId, revision: 1, sourceId: nullableId(config.sourceId), channelId, userId: null }
}

async function updateChannel(
  principals: ActivePrincipalAccess,
  executor: PoolConnection,
  _actorUserId: number,
  channelId: string,
  expectedRevision: number,
  config: ObserverChannelConfig,
): Promise<CommandEffect> {
  validateId(channelId, 'observer_channel_id_invalid')
  validateExpectedRevision(expectedRevision, false)
  validateChannelConfig(config)
  // Read the channel without a write lock first so the lock order remains
  // source -> channel, matching source.update's source -> referencing channels.
  const existingSnapshot = await selectChannel(executor, channelId, false)
  if (!existingSnapshot) throw managementError('observer_channel_not_found', 404)
  const existingSnapshotRevision = toRevision(existingSnapshot.revision)
  if (existingSnapshotRevision !== expectedRevision) throw managementError('observer_channel_revision_conflict', 409)

  const source = config.sourceId ? await selectSourceForChannel(executor, config.sourceId, true) : null
  if (config.sourceId && !source) throw managementError('observer_source_not_found', 404)
  if (config.active) {
    if (!source) throw managementError('observer_channel_source_required', 409)
    await assertSourceAvailable(principals, executor, source)
  }
  const existing = await selectChannel(executor, channelId, true)
  if (!existing) throw managementError('observer_channel_not_found', 404)
  const existingRevision = toRevision(existing.revision)
  if (existingRevision !== expectedRevision) throw managementError('observer_channel_revision_conflict', 409)
  const nextRevision = nextEntityRevision(existingRevision, 'observer_channel_revision_conflict')
  const accountId = source ? nullableId(source.trading_account_id) : null
  const sourceChanged = nullableId(existing.source_id) !== nullableId(config.sourceId)
  let sourceAvailable = false
  if (source) {
    if (config.active) {
      sourceAvailable = true
    } else {
      sourceAvailable = await isSourceAvailable(principals, executor, source)
    }
  }
  const keepDefault = databaseFlag(existing.is_default) && config.active && sourceAvailable
  const [updated] = await executor.execute<ResultSetHeader>(`UPDATE observer_channels SET
      source_trading_account_id=?,display_name=?,active=?,source_id=?,slug=?,description=?,audience=?,
      is_default=?,sort_order=?,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
    WHERE id=? AND revision=?`, [
    accountId, config.displayName, config.active ? 1 : 0, config.sourceId, config.slug, config.description,
    config.audience, keepDefault ? 1 : 0, config.sortOrder, channelId, expectedRevision,
  ])
  if (updated.affectedRows !== 1) throw managementError('observer_channel_revision_conflict', 409)
  return {
    targetId: channelId,
    revision: nextRevision,
    // A source swap invalidates both the old and new source projections.  The
    // dispatcher therefore receives the channel dimension only and performs a
    // fresh authorization resync instead of retaining an old-source filter.
    sourceId: sourceChanged ? null : nullableId(config.sourceId),
    channelId,
    userId: null,
  }
}

async function setDefaultChannel(principals: ActivePrincipalAccess, executor: PoolConnection, channelId: string | null, expectedRevision: number, registryRevision: number): Promise<CommandEffect> {
  validateExpectedRevision(expectedRevision)
  if (channelId !== null) validateId(channelId, 'observer_channel_id_invalid')
  if (registryRevision !== expectedRevision) throw managementError('observer_management_revision_conflict', 409)

  let selected: ChannelRow | null = null
  if (channelId !== null) {
    const selectedSnapshot = await selectChannel(executor, channelId, false)
    if (!selectedSnapshot) throw managementError('observer_channel_not_found', 404)
    await assertSourceAvailableForChannel(principals, executor, selectedSnapshot)
    selected = await selectChannel(executor, channelId, true)
    if (!selected) throw managementError('observer_channel_not_found', 404)
    // Re-read readiness after taking the row lock.  Ownership/account
    // projections may be changed by a different writer between the initial
    // snapshot and this command's final state change.
    await assertSourceAvailableForChannel(principals, executor, selected)
  }
  const [currentRows] = await executor.execute<ChannelRow[]>(`SELECT ${CHANNEL_COLUMNS}
    FROM observer_channels c WHERE c.is_default=1 ORDER BY c.id LIMIT 1 FOR UPDATE`)
  const current = currentRows[0] ?? null
  const selectedId = selected ? String(selected.id) : null
  const currentId = current ? String(current.id) : null
  const currentNextRevision = current && currentId !== selectedId
    ? nextEntityRevision(toRevision(current.revision), 'observer_channel_revision_conflict')
    : null
  const selectedNextRevision = selected && currentId !== selectedId
    ? nextEntityRevision(toRevision(selected.revision), 'observer_channel_revision_conflict')
    : null
  if (current && currentId !== selectedId) {
    await executor.execute<ResultSetHeader>(`UPDATE observer_channels SET is_default=0,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
      WHERE id=? AND is_default=1`, [current.id])
  }
  if (selected && currentId !== selectedId) {
    await executor.execute<ResultSetHeader>(`UPDATE observer_channels SET is_default=1,updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
      WHERE id=? AND is_default=0`, [selected.id])
  }
  const revision = selected
    ? (currentId === selectedId ? toRevision(selected.revision) : selectedNextRevision!)
    : current ? currentNextRevision! : 0
  const sourceId = selected ? nullableId(selected.source_id) : current ? nullableId(current.source_id) : null
  return { targetId: channelId ?? 'default', revision, sourceId, channelId, userId: null }
}

async function setChannelAccess(
  principals: ActivePrincipalAccess,
  executor: PoolConnection,
  actorUserId: number,
  channelId: string,
  userId: number,
  granted: boolean,
  expectedRevision: number,
): Promise<CommandEffect> {
  validateId(channelId, 'observer_channel_id_invalid')
  validateUserId(userId, 'observer_access_user_id_invalid')
  validateExpectedRevision(expectedRevision)
  const channel = await selectChannel(executor, channelId, true)
  if (!channel) throw managementError('observer_channel_not_found', 404)
  await assertActiveUser(principals, userId, 'observer_access_user_not_found')
  const [rows] = await executor.execute<AccessRow[]>(`SELECT ${ACCESS_COLUMNS}
    FROM observer_channel_accesses x WHERE x.observer_channel_id=? AND x.user_id=? LIMIT 1 FOR UPDATE`, [channelId, userId])
  const existing = rows[0] ?? null
  const actualRevision = existing ? toRevision(existing.revision) : 0
  if (actualRevision !== expectedRevision) throw managementError('observer_access_revision_conflict', 409)
  let revision = actualRevision
  if (!existing) {
    revision = 1
    await executor.execute(`INSERT INTO observer_channel_accesses
      (observer_channel_id,user_id,granted_at_utc,revoked_at_utc,granted_by_user_id,revision)
      VALUES (?,?,UTC_TIMESTAMP(3),${granted ? 'NULL' : 'UTC_TIMESTAMP(3)'},?,1)`, [channelId, userId, actorUserId])
  } else if ((granted && existing.revoked_at_utc !== null) || (!granted && existing.revoked_at_utc === null)) {
    revision = nextEntityRevision(actualRevision, 'observer_access_revision_conflict')
    const [updated] = await executor.execute<ResultSetHeader>(`UPDATE observer_channel_accesses SET
      granted_at_utc=IF(?,UTC_TIMESTAMP(3),granted_at_utc),revoked_at_utc=IF(?,NULL,UTC_TIMESTAMP(3)),
      granted_by_user_id=?,revision=?
      WHERE observer_channel_id=? AND user_id=? AND revision=?`, [
      granted ? 1 : 0, granted ? 1 : 0, actorUserId, revision, channelId, userId, actualRevision,
    ])
    if (updated.affectedRows !== 1) throw managementError('observer_access_revision_conflict', 409)
  }
  return {
    targetId: channelId,
    revision,
    sourceId: nullableId(channel.source_id),
    channelId,
    userId,
  }
}

async function selectSource(executor: Executor, sourceId: string, lock: boolean): Promise<SourceRow | null> {
  const [rows] = await executor.execute<SourceRow[]>(`SELECT ${SOURCE_COLUMNS}
    FROM observer_sources s WHERE s.id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [sourceId])
  return rows[0] ?? null
}

async function selectSourceForChannel(executor: Executor, sourceId: string, lock: boolean): Promise<SourceRow | null> {
  const source = await selectSource(executor, sourceId, lock)
  return source
}

async function selectChannel(executor: Executor, channelId: string, lock: boolean): Promise<ChannelRow | null> {
  const [rows] = await executor.execute<ChannelRow[]>(`SELECT ${CHANNEL_COLUMNS}
    FROM observer_channels c WHERE c.id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [channelId])
  return rows[0] ?? null
}

async function assertSourceAvailableForChannel(principals: ActivePrincipalAccess, executor: PoolConnection, channel: ChannelRow) {
  if (channel.active !== 1 && channel.active !== true) throw managementError('observer_channel_not_available', 409)
  if (typeof channel.slug !== 'string' || channel.slug.length === 0) throw managementError('observer_channel_not_available', 409)
  if (!channel.source_id) throw managementError('observer_channel_source_required', 409)
  const source = await selectSource(executor, nullableId(channel.source_id)!, false)
  if (!source) throw managementError('observer_source_not_found', 404)
  if (nullableId(source.trading_account_id) !== nullableId(channel.source_trading_account_id)) {
    throw managementError('observer_channel_source_mismatch', 409)
  }
  await assertSourceAvailable(principals, executor, source)
}

async function assertSourceAvailable(principals: ActivePrincipalAccess, executor: PoolConnection, source: SourceRow) {
  if (source.status !== 'active' || source.configuration_status !== 'ready' || !source.trading_account_id) {
    throw managementError('observer_source_not_ready', 409)
  }
  const operatorUserId = toSafeUserId(source.operator_user_id)
  await assertOwnedAccount(principals, executor, operatorUserId, nullableId(source.trading_account_id)!)
}

async function isSourceAvailable(principals: ActivePrincipalAccess, executor: PoolConnection, source: SourceRow) {
  if (source.status !== 'active' || source.configuration_status !== 'ready' || !source.trading_account_id) return false
  try {
    await assertOwnedAccount(principals, executor, toSafeUserId(source.operator_user_id), nullableId(source.trading_account_id)!)
    return true
  } catch (error) {
    if (error instanceof ObserverManagementError && error.status === 403) return false
    throw error
  }
}

async function assertOwnedAccount(principals: ActivePrincipalAccess, executor: Executor, userId: number, accountId: string) {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT a.id,a.ownership_revision,o.interval_id,o.granted_at_utc,
      oi.started_at_utc,oi.ended_at_utc,oi.role interval_role
    FROM trading_accounts a
    INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=?
      AND o.role='owner' AND o.revoked_at_utc IS NULL AND o.revision=a.ownership_revision
    INNER JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id
      AND oi.user_id=o.user_id AND oi.trading_account_id=o.trading_account_id AND oi.role='owner'
      AND oi.ended_at_utc IS NULL AND oi.started_at_utc=o.granted_at_utc AND oi.started_at_utc<=UTC_TIMESTAMP(3)
    WHERE a.id=? AND a.deleted_at_utc IS NULL LIMIT 1 FOR SHARE`, [userId, accountId])
  if (rows.length !== 1 || !await principals.isActive(userId, 'share')) throw managementError('observer_account_not_owned', 403)
}

async function assertAnalysisStrategy(strategies: AnalysisStrategyAccess, userId: number, strategyId: string) {
  if (!await strategies.canUse(userId, strategyId)) throw managementError('observer_analysis_strategy_not_available', 409)
}

async function assertActiveUser(principals: ActivePrincipalAccess, userId: number, code: string) {
  if (!await principals.isActive(userId, 'share')) throw managementError(code, 404)
}

async function assertAdmin(access: AdminPrincipalAccess, userId: number, lock: 'none' | 'share') {
  if (!await access.isAdmin(userId, lock)) throw managementError('observer_management_admin_required', 403)
}

async function findReceipt(executor: Executor, actorUserId: number, idempotencyKey: string): Promise<ReceiptRow | null> {
  const [rows] = await executor.execute<ReceiptRow[]>(`SELECT id,actor_user_id,idempotency_key,request_hash,action,target_id,result_json,created_at_utc
    FROM observer_management_operations WHERE actor_user_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE`, [actorUserId, idempotencyKey])
  return rows[0] ?? null
}

async function readRegistryRevision(executor: Executor) {
  const [rows] = await executor.execute<RegistryRow[]>('SELECT revision FROM observer_management_registry WHERE id=1 LIMIT 1')
  const row = rows[0]
  if (!row) throw managementError('observer_management_storage_unavailable', 503)
  return toRevision(row.revision)
}

async function currentRegistry(executor: Executor) {
  const [rows] = await executor.execute<RegistryRow[]>('SELECT revision FROM observer_management_registry WHERE id=1 LIMIT 1 FOR UPDATE')
  const row = rows[0]
  if (!row) throw managementError('observer_management_storage_unavailable', 503)
  return { revision: toRevision(row.revision) }
}

async function lockRegistry(executor: Executor) {
  return currentRegistry(executor)
}

async function bumpRegistry(executor: PoolConnection, expectedRevision: number) {
  // Registry revisions are returned as safe JavaScript integers and are part
  // of every authorization event.  Refuse the terminal value before issuing
  // an unsafe increment.
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw managementError('observer_management_revision_conflict', 409)
  }
  const [result] = await executor.execute<ResultSetHeader>(`UPDATE observer_management_registry
    SET revision=revision+1 WHERE id=1 AND revision=?`, [expectedRevision])
  if (result.affectedRows !== 1) throw managementError('observer_management_revision_conflict', 409)
  return expectedRevision + 1
}

async function writeAuthorizationInvalidation(
  executor: PoolConnection,
  operationId: string,
  dimensions: EventDimensions,
  registryRevision: number,
) {
  const payload = {
    source_id: dimensions.sourceId,
    channel_id: dimensions.channelId,
    user_id: dimensions.userId,
    registry_revision: registryRevision,
  }
  await executor.execute(`INSERT INTO outbox_events
    (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [
    randomUUID(), 'observer_management', operationId, 'observer.authorization.changed', JSON.stringify(payload),
  ])
}

function dimensions(command: ObserverManagementCommand, effect: CommandEffect): EventDimensions {
  if (command.kind === 'access.set') return { sourceId: effect.sourceId, channelId: effect.channelId, userId: effect.userId }
  // Changing the default observation channel invalidates subscribers of both
  // the old and new channel.  The event is therefore intentionally global;
  // the dispatcher must rebuild the current publication set from MySQL.
  if (command.kind === 'channel.default') return { sourceId: null, channelId: null, userId: null }
  return { sourceId: effect.sourceId, channelId: effect.channelId, userId: null }
}

function mapListItem(kind: ObserverManagementList['kind'], row: RowDataPacket): Record<string, unknown> {
  if (kind === 'sources') {
    const value = row as SourceRow
    return {
      id: String(value.id), display_name: value.display_name, notes: value.notes,
      operator_user_id: toSafeUserId(value.operator_user_id), trading_account_id: nullableId(value.trading_account_id),
      analysis_strategy_id: nullableId(value.analysis_strategy_id), status: value.status,
      configuration_status: value.configuration_status, created_by_user_id: toSafeUserId(value.created_by_user_id),
      created_at_utc: toIso(value.created_at_utc), updated_at_utc: toIso(value.updated_at_utc), revision: toRevision(value.revision),
    }
  }
  if (kind === 'channels') {
    const value = row as ChannelRow
    return {
      id: String(value.id), source_id: nullableId(value.source_id), source_trading_account_id: nullableId(value.source_trading_account_id),
      display_name: value.display_name, slug: value.slug, description: value.description, audience: value.audience,
      active: databaseFlag(value.active), is_default: databaseFlag(value.is_default), sort_order: Number(value.sort_order),
      created_at_utc: toIso(value.created_at_utc), updated_at_utc: value.updated_at_utc === null ? null : toIso(value.updated_at_utc),
      revision: toRevision(value.revision),
    }
  }
  if (kind === 'accesses') {
    const value = row as AccessRow
    return {
      observer_channel_id: String(value.observer_channel_id), user_id: toSafeUserId(value.user_id),
      granted_at_utc: toIso(value.granted_at_utc), revoked_at_utc: value.revoked_at_utc === null ? null : toIso(value.revoked_at_utc),
      granted_by_user_id: value.granted_by_user_id === null ? null : toSafeUserId(value.granted_by_user_id), revision: toRevision(value.revision),
    }
  }
  const value = row as OperationRow
  return {
    id: value.id, action: value.action, actor_user_id: toSafeUserId(value.actor_user_id), target_id: value.target_id,
    result: parseResult(value.result_json), audit: parseAudit(value.audit_json), created_at_utc: toIso(value.created_at_utc),
  }
}

function databaseFlag(value: number | boolean) { return value === 1 || value === true }

function nextEntityRevision(currentRevision: number, code: string) {
  if (currentRevision >= Number.MAX_SAFE_INTEGER) throw managementError(code, 409)
  return currentRevision + 1
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  let connection: PoolConnection | null = null
  let committing = false
  let destroyed = false
  try {
    const tx = await pool.getConnection()
    connection = tx
    await tx.beginTransaction()
    const result = await work(tx)
    committing = true
    await tx.commit()
    return result
  } catch (error) {
    if (committing && connection) {
      destroyed = true
      connection.destroy()
      throw managementError('observer_management_commit_unknown', 503)
    }
    if (connection) {
      try { await connection.rollback() } catch {
        destroyed = true
        connection.destroy()
      }
    }
    if (error instanceof ObserverManagementError) throw error
    throw translateStorageError(error)
  } finally {
    if (!destroyed) connection?.release()
  }
}

function translateStorageError(error: unknown): ObserverManagementError {
  const code = String((error as { code?: unknown })?.code ?? '')
  if (code === 'ER_DUP_ENTRY') return managementError('observer_management_conflict', 409)
  if (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT') return managementError('observer_management_storage_unavailable', 503)
  return managementError('observer_management_storage_unavailable', 503)
}
