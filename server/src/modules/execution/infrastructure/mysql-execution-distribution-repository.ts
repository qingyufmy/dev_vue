import { subscriptionWindowFingerprint } from '../../strategies/index.js'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { JsonObject } from '../../inference/index.js'
import type { Operation } from '../domain/execution.js'
import {
  ExecutionDistributionError,
  freezeDistributionTarget,
  freezeEligibleDistributionTargets,
  selectExactDistributionCloseTargets,
  type DistributionKind,
  type DistributionOrderCommand,
  type DistributionStatus,
  type DistributionTargetStatus,
  type ExecutionDistribution,
  type ExecutionDistributionResult,
  type ExactDistributionOutcome,
  type FrozenDistributionContext,
  type FrozenDistributionTarget,
  type NormalizedCreateDistributionCloseInput,
  type NormalizedCreateDistributionInput,
} from '../domain/execution-distribution.js'
import type {
  ActiveTraderStrategyVersion,
  DistributionFreezeReader,
  ExecutionDistributionRepository,
  ExecutionDistributionTargetRepository,
  DistributionTargetCompletion,
  RunnableDistributionTarget,
} from '../application/execution-distribution-ports.js'
import { sha256Canonical } from '../domain/execution.js'

interface StrategyRow extends RowDataPacket {
  strategy_id: string
  version_id: string
  revision: number
  kind: 'trader'
  status: 'active'
}

interface CandidateRow extends RowDataPacket {
  receive_timezone: string; receive_window_json: unknown
  subscription_id: string
  target_user_id: number
  trading_account_id: string
  standard_symbol: string
  subscription_revision: number
  trader_strategy_id: string
  trader_strategy_version_id: string
  currency: string
  trade_permission: number
  account_revision: number | null
  positions_revision: number | null
  pending_orders_revision: number | null
  quote_revision: number | null
  contract_revision: number | null
  risk_revision: number | null
  account_snapshot_id: string | null
  quote_snapshot_id: string | null
  contract_snapshot_id: string | null
  risk_snapshot_id: string | null
}

interface DistributionRow extends RowDataPacket {
  id: string
  parent_operation_id: string
  actor_user_id: number
  strategy_id: string
  strategy_version_id: string
  kind: DistributionKind
  source_distribution_id: string | null
  idempotency_key: string
  request_sha256: string
  command_json: string | object
  status: DistributionStatus
  target_count: number
  result_summary_json: string | object
  created_at_utc: Date | string
  updated_at_utc: Date | string
  completed_at_utc: Date | string | null
  revision: number
}

interface OperationRow extends RowDataPacket {
  id: string
  user_id: number
  trading_account_id: string | null
  kind: Operation['kind']
  status: Operation['status']
  source_type: Operation['sourceType']
  source_id: string
  idempotency_scope: Operation['idempotencyScope']
  idempotency_key: string
  request_sha256: string
  resource_type: Operation['resourceType']
  resource_id: string | null
  parent_operation_id: string | null
  distribution_id: string | null
  result_summary_json: string | object | null
  error_code: string | null
  accepted_at_utc: Date | string
  updated_at_utc: Date | string
  completed_at_utc: Date | string | null
  revision: number
}

interface TargetRow extends RowDataPacket {
  id: string
  distribution_id: string
  target_user_id: number
  trading_account_id: string
  subscription_id: string | null
  subscription_revision: number | null
  source_outcome_id: string | null
  source_ticket: string | null
  child_operation_id: string | null
  request_sha256: string
  frozen_context_json: string | object
  status: DistributionTargetStatus
  error_code: string | null
  created_at_utc: Date | string
  updated_at_utc: Date | string
  completed_at_utc: Date | string | null
  revision: number
}

interface SourceOutcomeRow extends RowDataPacket {
  quote_symbol: string; contract_symbol: string
  target_id: string
  outcome_id: string
  source_ticket: string
  outcome_revision: number
  target_user_id: number
  trading_account_id: string
  subscription_id: string | null
  subscription_revision: number | null
  frozen_context_json: string | object
  currency: string
  trade_permission: number
  account_revision: number | null
  positions_revision: number | null
  pending_orders_revision: number | null
  quote_revision: number | null
  contract_revision: number | null
  risk_revision: number | null
  resource_revision: number | null
}

interface TargetStatusCountRow extends RowDataPacket { status: DistributionTargetStatus; quantity: number }

const distributionSelect = `SELECT d.id,d.parent_operation_id,d.actor_user_id,CAST(d.strategy_id AS CHAR) strategy_id,CAST(d.strategy_version_id AS CHAR) strategy_version_id,d.kind,d.source_distribution_id,d.idempotency_key,d.request_sha256,d.command_json,d.status,d.target_count,d.result_summary_json,d.created_at_utc,d.updated_at_utc,d.completed_at_utc,d.revision FROM execution_distributions d`
const operationSelect = `SELECT op.id,op.user_id,CAST(op.trading_account_id AS CHAR) trading_account_id,op.kind,op.status,op.source_type,op.source_id,op.idempotency_scope,op.idempotency_key,op.request_sha256,op.resource_type,op.resource_id,op.parent_operation_id,op.distribution_id,op.result_summary_json,op.error_code,op.accepted_at_utc,op.updated_at_utc,op.completed_at_utc,op.revision FROM operations op`
const targetSelect = `SELECT t.id,t.distribution_id,t.target_user_id,CAST(t.trading_account_id AS CHAR) trading_account_id,CAST(t.subscription_id AS CHAR) subscription_id,t.subscription_revision,t.source_outcome_id,t.source_ticket,t.child_operation_id,t.request_sha256,t.frozen_context_json,t.status,t.error_code,t.created_at_utc,t.updated_at_utc,t.completed_at_utc,t.revision FROM execution_distribution_targets t`

export class MysqlExecutionDistributionRepository implements ExecutionDistributionRepository, DistributionFreezeReader, ExecutionDistributionTargetRepository {
  constructor(private readonly pool: Pool) {}

  async findByIdempotency(input: { actorUserId: number; idempotencyKey: string }) {
    const [rows] = await this.pool.execute<DistributionRow[]>(`${distributionSelect} WHERE d.actor_user_id=? AND d.idempotency_key=? LIMIT 1`, [input.actorUserId, input.idempotencyKey])
    const row = rows[0]
    if (!row) return null
    return { requestHash: row.request_sha256, result: await this.loadResult(this.pool, input.actorUserId, row.id) }
  }

  async createManualOrderDistribution(input: NormalizedCreateDistributionInput) {
    return transaction(this.pool, async connection => {
      const existing = await this.findIdempotency(connection, input.actorUserId, input.idempotencyKey)
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw new ExecutionDistributionError('distribution_idempotency_conflict', 409)
        return existing.result
      }
      const strategy = await this.loadActiveTraderStrategyVersion(connection, input.strategyId)
      if (!strategy) throw new ExecutionDistributionError('distribution_strategy_not_active', 409)
      const candidates = await this.listEligibleTargets(connection, input.strategyId, strategy.versionId, input.command.symbol)
      const now = new Date().toISOString()
      const distributionId = randomUUID()
      const commandJson = commandJsonFor(input.command)
      const targets = freezeEligibleDistributionTargets(candidates, input.strategyId, strategy.versionId, input.command.symbol, distributionId, commandJson, now, randomUUID)
      const result = await this.persistFrozenDistribution(connection, {
        actorUserId: input.actorUserId,
        strategyId: input.strategyId,
        strategyVersionId: strategy.versionId,
        kind: 'manual_order',
        sourceDistributionId: null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        command: commandJson,
        distributionId,
        targets,
        now,
      })
      return result
    })
  }

  async createDistributionClose(input: NormalizedCreateDistributionCloseInput) {
    return transaction(this.pool, async connection => {
      const existing = await this.findIdempotency(connection, input.actorUserId, input.idempotencyKey)
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw new ExecutionDistributionError('distribution_idempotency_conflict', 409)
        return existing.result
      }
      const source = await this.loadSourceDistribution(connection, input.actorUserId, input.sourceDistributionId)
      if (!source) throw new ExecutionDistributionError('distribution_source_not_found', 404)
      if (source.kind !== 'manual_order') throw new ExecutionDistributionError('distribution_source_kind_invalid', 409)
      if (Number(source.revision) !== input.expectedRevision) throw new ExecutionDistributionError('distribution_revision_conflict', 409, { actual_revision: Number(source.revision) })
      const sourceRows = await this.listAttributableSourceOutcomes(connection, source.id)
      const outcomes: ExactDistributionOutcome[] = sourceRows.map(row => ({ targetId: row.target_id, outcomeId: row.outcome_id, ticket: row.source_ticket, resourceKind: 'position', status: 'succeeded', outcomeRevision: Number(row.outcome_revision) }))
      const selected = selectExactDistributionCloseTargets(outcomes, input.targetIds)
      const selectedKeys = new Set(selected.map(item => `${item.targetId}:${item.outcomeId}`))
      const now = new Date().toISOString()
      const distributionId = randomUUID()
      const commandJson: JsonObject = {
        command_type: 'close_position',
        source_distribution_id: source.id,
        target_ids: selected.map(item => item.targetId),
      }
      const targets = sourceRows
        .filter(row => selectedKeys.has(`${row.target_id}:${row.outcome_id}`))
        .sort((left, right) => left.target_id.localeCompare(right.target_id))
        .map(row => this.closeTargetFromSource(row, source, distributionId, commandJson, now, randomUUID()))
      return this.persistFrozenDistribution(connection, {
        actorUserId: input.actorUserId,
        strategyId: source.strategy_id,
        strategyVersionId: source.strategy_version_id,
        kind: 'close',
        sourceDistributionId: source.id,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        command: commandJson,
        distributionId,
        targets,
        now,
      })
    })
  }

  async getDistribution(input: { actorUserId: number; distributionId: string }) {
    const [rows] = await this.pool.execute<DistributionRow[]>(`${distributionSelect} WHERE d.id=? AND d.actor_user_id=? LIMIT 1`, [input.distributionId, input.actorUserId])
    if (!rows[0]) return null
    return this.loadResult(this.pool, input.actorUserId, rows[0].id)
  }

  async previewManualOrderDistribution(input: { actorUserId: number; strategyId: string; symbol: string }) {
    void input.actorUserId
    const strategy = await readActiveTraderStrategyVersion(this.pool, input.strategyId)
    if (!strategy) throw new ExecutionDistributionError('distribution_strategy_not_active', 409)
    const candidates = await queryEligibleTargets(this.pool, input.strategyId, strategy.versionId, input.symbol, false)
    const uniqueAccounts = candidates.filter((candidate, index) => index === 0 || candidates[index - 1]?.accountId !== candidate.accountId)
    const targets = uniqueAccounts.map((candidate) => {
      const revisions = {
        account: candidate.accountRevision,
        positions: candidate.positionsRevision,
        pending_orders: candidate.pendingOrdersRevision,
        quote: candidate.quoteRevision,
        contract: candidate.contractRevision,
        risk: candidate.riskRevision,
      } as const
      const missingResources = (Object.entries(revisions) as Array<[keyof typeof revisions, number]>)
        .filter(([, revision]) => revision < 1)
        .map(([resource]) => resource)
      return {
        accountId: candidate.accountId,
        subscriptionId: candidate.subscriptionId,
        tradePermission: candidate.tradePermission,
        ready: candidate.tradePermission && missingResources.length === 0,
        missingResources,
      }
    })
    return {
      strategyId: strategy.strategyId,
      strategyVersionId: strategy.versionId,
      strategyRevision: strategy.revision,
      symbol: input.symbol,
      targetCount: targets.length,
      targets,
    }
  }

  async claimTarget(targetId: string, now: Date): Promise<RunnableDistributionTarget | null> {
    return transaction(this.pool, async connection => {
      const [targetRows] = await connection.execute<TargetRow[]>(`${targetSelect} WHERE t.id=? LIMIT 1 FOR UPDATE`, [targetId])
      const row = targetRows[0]
      if (!row || row.child_operation_id || !['queued', 'running'].includes(row.status)) return null
      if (row.status === 'queued') {
        await connection.execute(`UPDATE execution_distribution_targets SET status='running',updated_at_utc=?,revision=revision+1 WHERE id=? AND status='queued' AND child_operation_id IS NULL`, [now, targetId])
        row.status = 'running'
        row.updated_at_utc = now
        row.revision = Number(row.revision) + 1
      }
      const [distributionRows] = await connection.execute<DistributionRow[]>(`${distributionSelect} WHERE d.id=? LIMIT 1 FOR UPDATE`, [row.distribution_id])
      const distributionRow = distributionRows[0]
      if (!distributionRow) throw new ExecutionDistributionError('distribution_not_found', 404)
      const [operationRows] = await connection.execute<OperationRow[]>(`${operationSelect} WHERE op.id=? LIMIT 1 FOR UPDATE`, [distributionRow.parent_operation_id])
      const operationRow = operationRows[0]
      if (!operationRow) throw new ExecutionDistributionError('distribution_operation_missing', 500)
      const mappedTarget = mapTarget(row)
      const frozenHash = sha256Canonical({
        distributionId: mappedTarget.distributionId,
        targetId: mappedTarget.id,
        command: parse<JsonObject>(distributionRow.command_json),
        frozenContext: mappedTarget.frozenContext,
        sourceOutcomeId: mappedTarget.sourceOutcomeId,
        sourceTicket: mappedTarget.sourceTicket,
      })
      if (frozenHash !== mappedTarget.requestHash) {
        await connection.execute(`UPDATE execution_distribution_targets SET status='rejected',error_code='distribution_target_snapshot_invalid',updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [now, row.id, row.revision])
        await refreshDistributionAggregate(connection, distributionRow.id, now.toISOString())
        return null
      }
      await refreshDistributionAggregate(connection, distributionRow.id, now.toISOString())
      return { distribution: mapDistribution(distributionRow), parentOperation: mapOperation(operationRow), target: mappedTarget }
    })
  }

  async completeTarget(input: DistributionTargetCompletion, now: Date): Promise<void> {
    await transaction(this.pool, async connection => {
      const [rows] = await connection.execute<TargetRow[]>(`${targetSelect} WHERE t.id=? LIMIT 1 FOR UPDATE`, [input.targetId])
      const row = rows[0]
      if (!row) throw new ExecutionDistributionError('distribution_target_not_found', 404)
      if (row.child_operation_id && row.child_operation_id !== input.childOperationId) {
        throw new ExecutionDistributionError('distribution_target_child_conflict', 409)
      }
      const unchanged = row.status === input.status
        && row.child_operation_id === input.childOperationId
        && row.error_code === input.errorCode
      if (!unchanged) {
        await connection.execute(`UPDATE execution_distribution_targets SET child_operation_id=?,status=?,error_code=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [input.childOperationId, input.status, input.errorCode, now, input.completedAt, row.id, row.revision])
      }
      await refreshDistributionAggregate(connection, row.distribution_id, now.toISOString())
    })
  }

  async loadActiveTraderStrategyVersion(connection: PoolConnection, strategyId: string): Promise<ActiveTraderStrategyVersion | null> {
    const [rows] = await connection.execute<StrategyRow[]>(`SELECT CAST(s.id AS CHAR) strategy_id,CAST(s.active_version_id AS CHAR) version_id,s.revision,s.kind,s.status FROM strategies s INNER JOIN strategy_versions v ON v.id=s.active_version_id AND v.strategy_id=s.id WHERE s.id=? AND s.kind='trader' AND s.status='active' AND s.deleted_at_utc IS NULL LIMIT 1 FOR SHARE`, [strategyId])
    const row = rows[0]
    return row ? { strategyId: row.strategy_id, versionId: row.version_id, revision: Number(row.revision), kind: 'trader', status: 'active' } : null
  }

  async listEligibleTargets(connection: PoolConnection, strategyId: string, strategyVersionId: string, symbol: string) {
    return queryEligibleTargets(connection, strategyId, strategyVersionId, symbol, true)
  }

  async listAttributableCloseOutcomes(connection: PoolConnection, sourceDistributionId: string) {
    const rows = await this.listAttributableSourceOutcomes(connection, sourceDistributionId)
    return rows.map(row => ({ targetId: row.target_id, outcomeId: row.outcome_id, ticket: row.source_ticket, resourceKind: 'position' as const, status: 'succeeded' as const, outcomeRevision: Number(row.outcome_revision) }))
  }

  private async listAttributableSourceOutcomes(connection: PoolConnection, sourceDistributionId: string) {
    const [rows] = await connection.execute<SourceOutcomeRow[]>(`SELECT t.id target_id,o.id outcome_id,o.ticket source_ticket,o.revision outcome_revision,t.target_user_id,CAST(t.trading_account_id AS CHAR) trading_account_id,CAST(t.subscription_id AS CHAR) subscription_id,t.subscription_revision,t.frozen_context_json,a.currency,COALESCE(ars.trade_permission,0) trade_permission,ars.revision account_revision,pr.revision positions_revision,por.revision pending_orders_revision,q.revision quote_revision,i.revision contract_revision,rs.revision risk_revision,p.revision resource_revision,q.symbol quote_symbol,i.symbol contract_symbol
      FROM execution_distribution_targets t
      INNER JOIN execution_outcomes o ON o.distribution_target_id=t.id AND o.status='succeeded' AND o.resource_kind='position' AND o.ticket IS NOT NULL AND o.ticket<>''
      INNER JOIN trading_accounts a ON a.id=t.trading_account_id AND a.deleted_at_utc IS NULL
      INNER JOIN open_position_snapshots p ON p.trading_account_id=t.trading_account_id AND p.ticket=o.ticket
      LEFT JOIN account_runtime_snapshots ars ON ars.trading_account_id=t.trading_account_id
      LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=t.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open'
      LEFT JOIN trading_projection_revisions por ON por.trading_account_id=t.trading_account_id AND por.resource_kind='pending_orders' AND por.resource_id='open'
      LEFT JOIN market_quotes q ON q.trading_account_id=t.trading_account_id AND q.symbol=(SELECT matched.symbol FROM market_quotes matched WHERE matched.trading_account_id=q.trading_account_id AND LEFT(UPPER(matched.symbol),CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(t.frozen_context_json,'$.subscription.symbol'))))=UPPER(JSON_UNQUOTE(JSON_EXTRACT(t.frozen_context_json,'$.subscription.symbol'))))
      LEFT JOIN market_instrument_snapshots i ON i.trading_account_id=t.trading_account_id AND i.symbol=(SELECT matched.symbol FROM market_instrument_snapshots matched WHERE matched.trading_account_id=i.trading_account_id AND LEFT(UPPER(matched.symbol),CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(t.frozen_context_json,'$.subscription.symbol'))))=UPPER(JSON_UNQUOTE(JSON_EXTRACT(t.frozen_context_json,'$.subscription.symbol'))))
      LEFT JOIN account_risk_summaries rs ON rs.trading_account_id=t.trading_account_id
      WHERE t.distribution_id=? AND NOT EXISTS (SELECT 1 FROM execution_distribution_targets prior WHERE prior.source_outcome_id=o.id)
      ORDER BY t.id,o.id FOR UPDATE`, [sourceDistributionId])
    return rows
  }

  private async loadSourceDistribution(connection: PoolConnection, actorUserId: number, distributionId: string) {
    const [rows] = await connection.execute<(DistributionRow & { strategy_id: string; strategy_version_id: string })[]>(`${distributionSelect} WHERE d.id=? AND d.actor_user_id=? LIMIT 1 FOR UPDATE`, [distributionId, actorUserId])
    return rows[0] ?? null
  }

  private closeTargetFromSource(row: SourceOutcomeRow, source: DistributionRow, distributionId: string, command: JsonObject, now: string, targetId: string) {
    const context = parse<FrozenDistributionContext>(row.frozen_context_json)
    const candidate = {
      ...candidateFromFrozenContext(context, row.target_user_id, row.trading_account_id, row.subscription_id, row.subscription_revision, source.strategy_id, source.strategy_version_id),
      accountCurrency: row.currency,
      tradePermission: Boolean(row.trade_permission),
      accountRevision: Number(row.account_revision ?? 0),
      positionsRevision: Number(row.positions_revision ?? 0),
      pendingOrdersRevision: Number(row.pending_orders_revision ?? 0),
      quoteRevision: Number(row.quote_revision ?? 0),
      contractRevision: Number(row.contract_revision ?? 0),
      riskRevision: Number(row.risk_revision ?? 0),
      accountSnapshotId: row.account_revision === null ? null : `account_runtime:${row.trading_account_id}:${row.account_revision}`,
      quoteSnapshotId: row.quote_revision === null ? null : `market_quote:${row.trading_account_id}:${row.quote_symbol}:${row.quote_revision}`,
      contractSnapshotId: row.contract_revision === null ? null : `market_contract:${row.trading_account_id}:${row.contract_symbol}:${row.contract_revision}`,
      riskSnapshotId: row.risk_revision === null ? null : `risk_summary:${row.trading_account_id}:${row.risk_revision}`,
    }
    const target = freezeDistributionTarget(candidate, distributionId, targetId, now, command, { outcomeId: row.outcome_id, ticket: row.source_ticket, sourceTargetId: row.target_id })
    target.frozenContext.expected.resourceRevision = Number(row.resource_revision ?? 0)
    target.requestHash = sha256Canonical({ distributionId, targetId, command, frozenContext: target.frozenContext, sourceOutcomeId: target.sourceOutcomeId, sourceTicket: target.sourceTicket })
    return target
  }

  private async persistFrozenDistribution(connection: PoolConnection, input: {
    actorUserId: number
    strategyId: string
    strategyVersionId: string
    kind: DistributionKind
    sourceDistributionId: string | null
    idempotencyKey: string
    requestHash: string
    command: JsonObject
    distributionId: string
    targets: FrozenDistributionTarget[]
    now: string
  }): Promise<ExecutionDistributionResult> {
    const hasTargets = input.targets.length > 0
    const status: 'queued' | 'rejected' = hasTargets ? 'queued' : 'rejected'
    const errorCode = hasTargets ? null : 'distribution_no_eligible_targets'
    const resultSummary: JsonObject = {
      target_count: input.targets.length,
      queued_targets: input.targets.length,
      rejected_targets: 0,
      succeeded_targets: 0,
      uncertain_targets: 0,
      ...(errorCode ? { error_code: errorCode } : {}),
    }
    const operationId = randomUUID()
    const operation: Operation = {
      id: operationId,
      userId: input.actorUserId,
      accountId: null,
      kind: input.kind === 'close' ? 'distribution_close' : 'execution_distribution',
      status,
      sourceType: input.kind === 'close' ? 'distribution_close' : 'strategy_distribution',
      sourceId: input.distributionId,
      idempotencyScope: input.kind === 'close' ? 'distribution_close' : 'strategy_distribution',
      idempotencyKey: sha256Canonical({ actorUserId: input.actorUserId, idempotencyKey: input.idempotencyKey }),
      requestHash: input.requestHash,
      resourceType: 'execution_distribution',
      resourceId: input.distributionId,
      errorCode,
      acceptedAt: input.now,
      updatedAt: input.now,
      completedAt: hasTargets ? null : input.now,
      revision: 1,
      intentIds: [],
      parentOperationId: null,
      distributionId: input.distributionId,
      resultSummary,
    }
    const distribution: ExecutionDistribution = {
      id: input.distributionId,
      operationId,
      actorUserId: input.actorUserId,
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      kind: input.kind,
      sourceDistributionId: input.sourceDistributionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      command: input.command,
      status,
      targetCount: input.targets.length,
      resultSummary,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: hasTargets ? null : input.now,
      revision: 1,
    }

    // operations <-> execution_distributions are circular FKs.  Insert the
    // operation with a null distribution_id, insert the distribution, then
    // fill the immutable link before creating targets/outbox.
    await connection.execute(`INSERT INTO operations (id,user_id,trading_account_id,kind,status,source_type,source_id,idempotency_scope,idempotency_key,request_sha256,resource_type,resource_id,parent_operation_id,distribution_id,result_summary_json,error_code,accepted_at_utc,updated_at_utc,completed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [operation.id, operation.userId, operation.accountId, operation.kind, operation.status, operation.sourceType, operation.sourceId, operation.idempotencyScope, operation.idempotencyKey, operation.requestHash, operation.resourceType, operation.resourceId, null, null, JSON.stringify(resultSummary), operation.errorCode, operation.acceptedAt, operation.updatedAt, operation.completedAt, operation.revision])
    await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,?,?,?,?,?,?,?)`, [operation.id, 'operation.created', null, operation.status, operation.errorCode, null, operation.revision, JSON.stringify({ kind: operation.kind, distribution_id: input.distributionId }), operation.acceptedAt])
    await connection.execute(`INSERT INTO execution_distributions (id,parent_operation_id,actor_user_id,strategy_id,strategy_version_id,kind,source_distribution_id,idempotency_key,request_sha256,command_json,status,target_count,result_summary_json,created_at_utc,updated_at_utc,completed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [distribution.id, operation.id, distribution.actorUserId, distribution.strategyId, distribution.strategyVersionId, distribution.kind, distribution.sourceDistributionId, distribution.idempotencyKey, distribution.requestHash, JSON.stringify(distribution.command), distribution.status, distribution.targetCount, JSON.stringify(distribution.resultSummary), distribution.createdAt, distribution.updatedAt, distribution.completedAt, distribution.revision])
    const [linked] = await connection.execute<ResultSetHeader>('UPDATE operations SET distribution_id=? WHERE id=? AND distribution_id IS NULL', [distribution.id, operation.id])
    if (linked.affectedRows !== 1) throw new ExecutionDistributionError('distribution_operation_link_conflict', 409)
    await insertTargets(connection, input.targets)
    await insertOutbox(connection, 'operation', operation.id, 'operation.changed', {
      operation_id: operation.id,
      account_id: null,
      status: operation.status,
      revision: String(operation.revision),
      updated_at: operation.updatedAt,
    })
    await insertTargetOutbox(connection, distribution.id, operation.id, input.targets)
    return { operation, distribution, targets: input.targets }
  }

  private async findIdempotency(executor: Pool | PoolConnection, actorUserId: number, idempotencyKey: string) {
    const [rows] = await executor.execute<DistributionRow[]>(`${distributionSelect} WHERE d.actor_user_id=? AND d.idempotency_key=? LIMIT 1 FOR UPDATE`, [actorUserId, idempotencyKey])
    const row = rows[0]
    if (!row) return null
    return { requestHash: row.request_sha256, result: await this.loadResult(executor, actorUserId, row.id) }
  }

  private async loadResult(executor: Pool | PoolConnection, actorUserId: number, distributionId: string): Promise<ExecutionDistributionResult> {
    const [distributionRows] = await executor.execute<DistributionRow[]>(`${distributionSelect} WHERE d.id=? AND d.actor_user_id=? LIMIT 1`, [distributionId, actorUserId])
    const distributionRow = distributionRows[0]
    if (!distributionRow) throw new ExecutionDistributionError('distribution_not_found', 404)
    const [operationRows] = await executor.execute<OperationRow[]>(`${operationSelect} WHERE op.id=? AND op.user_id=? LIMIT 1`, [distributionRow.parent_operation_id, actorUserId])
    const operationRow = operationRows[0]
    if (!operationRow) throw new ExecutionDistributionError('distribution_operation_missing', 500)
    const [targetRows] = await executor.execute<TargetRow[]>(`${targetSelect} WHERE t.distribution_id=? ORDER BY t.id`, [distributionId])
    return { operation: mapOperation(operationRow), distribution: mapDistribution(distributionRow), targets: targetRows.map(mapTarget) }
  }
}

async function readActiveTraderStrategyVersion(executor: Pool | PoolConnection, strategyId: string): Promise<ActiveTraderStrategyVersion | null> {
  const [rows] = await executor.execute<StrategyRow[]>(`SELECT CAST(s.id AS CHAR) strategy_id,CAST(s.active_version_id AS CHAR) version_id,s.revision,s.kind,s.status FROM strategies s INNER JOIN strategy_versions v ON v.id=s.active_version_id AND v.strategy_id=s.id WHERE s.id=? AND s.kind='trader' AND s.status='active' AND s.deleted_at_utc IS NULL LIMIT 1`, [strategyId])
  const row = rows[0]
  return row ? { strategyId: row.strategy_id, versionId: row.version_id, revision: Number(row.revision), kind: 'trader', status: 'active' } : null
}

async function queryEligibleTargets(executor: Pool | PoolConnection, strategyId: string, strategyVersionId: string, symbol: string, lock: boolean) {
  const lockClause = lock ? ' FOR UPDATE' : ''
  const [rows] = await executor.execute<CandidateRow[]>(`SELECT CAST(s.id AS CHAR) subscription_id,s.user_id target_user_id,CAST(s.trading_account_id AS CHAR) trading_account_id,s.standard_symbol,s.revision subscription_revision,sc.receive_timezone,sc.receive_window_json,CAST(s.trader_strategy_id AS CHAR) trader_strategy_id,CAST(ts.active_version_id AS CHAR) trader_strategy_version_id,a.currency,COALESCE(ars.trade_permission,0) trade_permission,ars.revision account_revision,pr.revision positions_revision,por.revision pending_orders_revision,q.revision quote_revision,i.revision contract_revision,rs.revision risk_revision,CASE WHEN ars.revision IS NULL THEN NULL ELSE CONCAT('account_runtime:',a.id,':',ars.revision) END account_snapshot_id,CASE WHEN q.revision IS NULL THEN NULL ELSE CONCAT('market_quote:',a.id,':',q.symbol,':',q.revision) END quote_snapshot_id,CASE WHEN i.revision IS NULL THEN NULL ELSE CONCAT('market_contract:',a.id,':',i.symbol,':',i.revision) END contract_snapshot_id,CASE WHEN rs.revision IS NULL THEN NULL ELSE CONCAT('risk_summary:',a.id,':',rs.revision) END risk_snapshot_id FROM strategy_subscriptions s INNER JOIN subscription_schedules sc ON sc.subscription_id=s.id INNER JOIN strategies ts ON ts.id=s.trader_strategy_id AND ts.kind='trader' AND ts.status='active' AND ts.deleted_at_utc IS NULL AND ts.active_version_id IS NOT NULL INNER JOIN strategy_versions tv ON tv.id=ts.active_version_id AND tv.strategy_id=s.trader_strategy_id INNER JOIN trading_accounts a ON a.id=s.trading_account_id AND a.deleted_at_utc IS NULL INNER JOIN trading_account_ownerships own ON own.trading_account_id=s.trading_account_id AND own.user_id=s.user_id AND own.role='owner' AND own.revoked_at_utc IS NULL LEFT JOIN account_runtime_snapshots ars ON ars.trading_account_id=s.trading_account_id LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=s.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open' LEFT JOIN trading_projection_revisions por ON por.trading_account_id=s.trading_account_id AND por.resource_kind='pending_orders' AND por.resource_id='open' LEFT JOIN market_quotes q ON q.trading_account_id=s.trading_account_id AND q.symbol=(SELECT matched.symbol FROM market_quotes matched WHERE matched.trading_account_id=q.trading_account_id AND LEFT(UPPER(matched.symbol),CHAR_LENGTH(s.standard_symbol))=UPPER(s.standard_symbol)) LEFT JOIN market_instrument_snapshots i ON i.trading_account_id=s.trading_account_id AND i.symbol=(SELECT matched.symbol FROM market_instrument_snapshots matched WHERE matched.trading_account_id=i.trading_account_id AND LEFT(UPPER(matched.symbol),CHAR_LENGTH(s.standard_symbol))=UPPER(s.standard_symbol)) LEFT JOIN account_risk_summaries rs ON rs.trading_account_id=s.trading_account_id WHERE s.status='active' AND s.trader_enabled=1 AND s.trade_send_enabled=1 AND s.trader_strategy_id=? AND ts.active_version_id=? AND s.standard_symbol=? ORDER BY s.trading_account_id,s.id${lockClause}`, [strategyId, strategyVersionId, symbol])
  return rows.map(row => ({
    subscriptionId: row.subscription_id,
    subscriptionWindowHash: subscriptionWindowFingerprint(row.receive_window_json, row.receive_timezone),
    userId: Number(row.target_user_id),
    accountId: row.trading_account_id,
    symbol: row.standard_symbol,
    subscriptionRevision: Number(row.subscription_revision),
    traderStrategyId: row.trader_strategy_id,
    traderStrategyVersionId: row.trader_strategy_version_id,
    accountCurrency: row.currency,
    tradePermission: Boolean(row.trade_permission),
    accountRevision: Number(row.account_revision ?? 0),
    positionsRevision: Number(row.positions_revision ?? 0),
    pendingOrdersRevision: Number(row.pending_orders_revision ?? 0),
    quoteRevision: Number(row.quote_revision ?? 0),
    contractRevision: Number(row.contract_revision ?? 0),
    riskRevision: Number(row.risk_revision ?? 0),
    accountSnapshotId: row.account_snapshot_id,
    quoteSnapshotId: row.quote_snapshot_id,
    contractSnapshotId: row.contract_snapshot_id,
    riskSnapshotId: row.risk_snapshot_id,
  }))
}

async function insertTargets(connection: PoolConnection, targets: FrozenDistributionTarget[]) {
  for (const chunk of chunks(targets, 250)) {
    const values = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const parameters = chunk.flatMap(target => [target.id, target.distributionId, target.userId, target.accountId, target.subscriptionId, target.subscriptionRevision, target.sourceOutcomeId, target.sourceTicket, target.childOperationId, target.requestHash, JSON.stringify(target.frozenContext), target.status, target.errorCode, target.createdAt, target.updatedAt, target.completedAt, target.revision])
    await connection.execute(`INSERT INTO execution_distribution_targets (id,distribution_id,target_user_id,trading_account_id,subscription_id,subscription_revision,source_outcome_id,source_ticket,child_operation_id,request_sha256,frozen_context_json,status,error_code,created_at_utc,updated_at_utc,completed_at_utc,revision) VALUES ${values}`, parameters)
  }
}

async function insertTargetOutbox(connection: PoolConnection, distributionId: string, operationId: string, targets: FrozenDistributionTarget[]) {
  for (const chunk of chunks(targets, 250)) {
    const values = chunk.map(() => "(?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))").join(',')
    const parameters = chunk.flatMap(target => [randomUUID(), 'execution_distribution_target', target.id, 'execution.distribution.target.requested', JSON.stringify({
      distribution_id: distributionId,
      distribution_target_id: target.id,
      operation_id: operationId,
    })])
    await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES ${values}`, parameters)
  }
}

async function insertOutbox(connection: PoolConnection, aggregateType: string, aggregateId: string, eventType: string, payload: JsonObject) {
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), aggregateType, aggregateId, eventType, JSON.stringify(payload)])
}

function mapOperation(row: OperationRow): Operation {
  return {
    id: row.id, userId: Number(row.user_id), accountId: row.trading_account_id, kind: row.kind, status: row.status,
    sourceType: row.source_type, sourceId: row.source_id, idempotencyScope: row.idempotency_scope, idempotencyKey: row.idempotency_key,
    requestHash: row.request_sha256, resourceType: row.resource_type, resourceId: row.resource_id, errorCode: row.error_code,
    acceptedAt: iso(row.accepted_at_utc), updatedAt: iso(row.updated_at_utc), completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null,
    revision: Number(row.revision), intentIds: [], parentOperationId: row.parent_operation_id, distributionId: row.distribution_id,
    resultSummary: row.result_summary_json === null ? null : parse<JsonObject>(row.result_summary_json),
  }
}

function mapDistribution(row: DistributionRow): ExecutionDistribution {
  return {
    id: row.id, operationId: row.parent_operation_id, actorUserId: Number(row.actor_user_id), strategyId: row.strategy_id, strategyVersionId: row.strategy_version_id,
    kind: row.kind, sourceDistributionId: row.source_distribution_id, idempotencyKey: row.idempotency_key, requestHash: row.request_sha256,
    command: parse<JsonObject>(row.command_json), status: row.status, targetCount: Number(row.target_count), resultSummary: parse<JsonObject>(row.result_summary_json),
    createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc), completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null, revision: Number(row.revision),
  }
}

function mapTarget(row: TargetRow): FrozenDistributionTarget {
  const context = parse<FrozenDistributionContext>(row.frozen_context_json)
  const expected = context.expected
  return {
    id: row.id, distributionId: row.distribution_id, userId: Number(row.target_user_id), accountId: row.trading_account_id,
    symbol: context.subscription.symbol, subscriptionId: row.subscription_id ?? '', subscriptionRevision: Number(row.subscription_revision ?? context.subscription.revision ?? 0),
    traderStrategyId: context.strategy.id, traderStrategyVersionId: context.strategy.versionId, accountCurrency: context.account.currency, tradePermission: context.account.tradePermission,
    accountRevision: expected.accountRevision, positionsRevision: expected.positionsRevision, pendingOrdersRevision: expected.pendingOrdersRevision,
    quoteRevision: expected.quoteRevision, contractRevision: expected.contractRevision, riskRevision: expected.riskRevision,
    accountSnapshotId: context.snapshots.account, quoteSnapshotId: context.snapshots.quote, contractSnapshotId: context.snapshots.contract, riskSnapshotId: context.snapshots.risk,
    sourceOutcomeId: row.source_outcome_id, sourceTicket: row.source_ticket, childOperationId: row.child_operation_id, requestHash: row.request_sha256,
    frozenContext: context, status: row.status, errorCode: row.error_code, createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc),
    completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null, revision: Number(row.revision),
  }
}

function candidateFromFrozenContext(context: FrozenDistributionContext, userId: number, accountId: string, subscriptionId: string | null, subscriptionRevision: number | null, strategyId: string, strategyVersionId: string) {
  return {
    ...(context.subscription.windowHash ? { subscriptionWindowHash: context.subscription.windowHash } : {}),
    subscriptionId: subscriptionId ?? context.subscription.id ?? '', userId, accountId, symbol: context.subscription.symbol,
    subscriptionRevision: Number(subscriptionRevision ?? context.subscription.revision ?? 0), traderStrategyId: strategyId, traderStrategyVersionId: strategyVersionId,
    accountCurrency: context.account.currency, tradePermission: context.account.tradePermission,
    accountRevision: context.expected.accountRevision, positionsRevision: context.expected.positionsRevision, pendingOrdersRevision: context.expected.pendingOrdersRevision,
    quoteRevision: context.expected.quoteRevision, contractRevision: context.expected.contractRevision, riskRevision: context.expected.riskRevision,
    accountSnapshotId: context.snapshots.account, quoteSnapshotId: context.snapshots.quote, contractSnapshotId: context.snapshots.contract, riskSnapshotId: context.snapshots.risk,
  }
}

async function refreshDistributionAggregate(connection: PoolConnection, distributionId: string, now: string) {
  const [countRows] = await connection.execute<TargetStatusCountRow[]>('SELECT status,COUNT(*) quantity FROM execution_distribution_targets WHERE distribution_id=? GROUP BY status FOR UPDATE', [distributionId])
  const counts = new Map(countRows.map(row => [row.status, Number(row.quantity)]))
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  const queued = counts.get('queued') ?? 0
  const running = counts.get('running') ?? 0
  const succeeded = counts.get('succeeded') ?? 0
  const rejected = counts.get('rejected') ?? 0
  const failed = counts.get('failed') ?? 0
  const uncertain = counts.get('uncertain') ?? 0
  const cancelled = counts.get('cancelled') ?? 0
  const expired = counts.get('expired') ?? 0
  const status: DistributionStatus = uncertain > 0 ? 'uncertain'
    : running > 0 || (queued > 0 && queued < total) ? 'running'
      : queued === total ? 'queued'
        : succeeded === total ? 'succeeded'
          : succeeded > 0 ? 'partially_succeeded'
            : rejected === total ? 'rejected'
              : 'failed'
  const terminal = !['queued', 'running', 'uncertain'].includes(status)
  const summary: JsonObject = {
    target_count: total,
    queued_targets: queued,
    running_targets: running,
    succeeded_targets: succeeded,
    rejected_targets: rejected,
    failed_targets: failed,
    uncertain_targets: uncertain,
    cancelled_targets: cancelled,
    expired_targets: expired,
  }
  const [distributionRows] = await connection.execute<DistributionRow[]>(`${distributionSelect} WHERE d.id=? LIMIT 1 FOR UPDATE`, [distributionId])
  const distribution = distributionRows[0]
  if (!distribution) throw new ExecutionDistributionError('distribution_not_found', 404)
  const changed = distribution.status !== status || JSON.stringify(parse<JsonObject>(distribution.result_summary_json)) !== JSON.stringify(summary)
  if (!changed) return
  await connection.execute('UPDATE execution_distributions SET status=?,result_summary_json=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, JSON.stringify(summary), now, terminal ? now : null, distributionId, distribution.revision])
  const [operationRows] = await connection.execute<OperationRow[]>(`${operationSelect} WHERE op.id=? LIMIT 1 FOR UPDATE`, [distribution.parent_operation_id])
  const operation = operationRows[0]
  if (!operation) throw new ExecutionDistributionError('distribution_operation_missing', 500)
  await connection.execute('UPDATE operations SET status=?,result_summary_json=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, JSON.stringify(summary), now, terminal ? now : null, operation.id, operation.revision])
  await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,?,?,NULL,?,?,?,?)`, [operation.id, `operation.${status}`, operation.status, status, operation.revision, operation.revision + 1, JSON.stringify({ distribution_id: distributionId, result_summary: summary }), now])
  await insertOutbox(connection, 'operation', operation.id, 'operation.changed', { operation_id: operation.id, status, revision: String(operation.revision + 1), updated_at: now })
}

function commandJsonFor(command: DistributionOrderCommand): JsonObject {
  if (command.commandType === 'market_order') return {
    command_type: 'market_order', symbol: command.symbol, side: command.side, volume: command.volume,
    stop_loss: command.stopLoss, take_profit: command.takeProfit, reference_price: command.referencePrice,
  }
  return {
    command_type: 'pending_order', symbol: command.symbol, order_type: command.orderType, volume: command.volume,
    price: command.price, stop_limit_price: command.stopLimitPrice, stop_loss: command.stopLoss, take_profit: command.takeProfit,
    reference_price: command.referencePrice, expiration_utc_msc: command.expirationUtcMsc,
  }
}

function parse<T>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }
function iso(value: Date | string) { return new Date(value).toISOString() }
function chunks<T>(values: T[], size: number) { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result }

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
