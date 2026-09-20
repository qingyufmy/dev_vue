import { unchangedUserCommandTradeState } from './mysql-user-command-trade-state.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'
import type { StrategyExecutionConfigReader } from '../../strategies/index.js'
import { bridgeCommandTransaction as transaction } from './bridge-command-transaction.js'
import { buildPartialClosePlan } from '../domain/partial-close-plan.js'
import type { PartialCloseProtectionPlan } from '../domain/partial-close-protection.js'
import { readCommandSourceAction } from './mysql-command-source-action.js'
import type { CapturePositionProtectionCommandProvider } from './position-protection-command-provider.js'
import type { CapturePositionProtectionDispatch } from './mysql-position-protection-dispatch-writer.js'
import type { CapturePartialCloseParentDispatch } from './mysql-partial-close-parent-dispatch-review.js'
import type { PositionProtectionCommandReview } from '../domain/position-protection-command-review.js'
import { wakePositionProtectionResult } from './mysql-position-protection-result-wakeup.js'
import { wakePartialCloseResult } from './mysql-partial-close-result-wakeup.js'
import { RiskError, type RiskDispatchPolicyReader } from '../../risk/index.js'
import { assertOrderDispatchPolicy } from '../domain/order-dispatch-policy.js'
import { executionOutcomeReference } from '../domain/execution-outcome-reference.js'
import { bridgeReconciliationTicket } from '../domain/bridge-reconciliation-ticket.js'
import type { AccountClockReader } from '../../trading/index.js'
import { randomUUID } from 'node:crypto'
import { assertDistributionWindow, assertRiskDecisionWindow } from './mysql-execution-window.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type {
  BridgeCommandRepository, BridgeResultPersistence,
} from '../application/bridge-command-ports.js'
import {
  BridgeCommandError, bridgeCommandInputMatches, routeContinues, routeMatches,
  type BridgeCommand, type BridgeCommandAcceptedEnvelope, type BridgeCommandResultEnvelope, type BridgeWireRoute,
} from '../domain/bridge-command.js'
import { ExecutionError, sha256Canonical } from '../domain/execution.js'
import type { ExecutionAction } from '../domain/execution-input.js'
import type { PendingCommandReviewer } from '../application/pending-command-reviewer.js'

interface CommandRow extends RowDataPacket {
  id: string; execution_intent_id: string; command_sequence: number; user_id: number; trading_account_id: string
  terminal_profile_id: string; terminal_instance_id: string; broker_server: string; account_login: string
  connection_epoch: string | number; action: BridgeCommand['action']; idempotency_key: string; request_sha256: string
  status: BridgeCommand['status']; issued_at_utc: Date; deadline_at_utc: Date; dispatched_at_utc: Date | null
  accepted_at_utc: Date | null; completed_at_utc: Date | null; error_code: string | null
  terminal_code: string | null; result_sha256: string | null; result_message_id: string | null; revision: number
  created_at_utc: Date; updated_at_utc: Date; request_envelope_json: string | BridgeCommand['request']
}
interface CommandLocator extends RowDataPacket { id: string; trading_account_id: string; execution_intent_id: string }
interface IntentRow extends RowDataPacket { id: string; operation_id: string; user_id: number; trading_account_id: string; action_kind: string; source_type: string; source_id: string; status: string; revision: number; expires_at_utc: Date }
interface ExistingResultRow extends RowDataPacket { bridge_command_id: string; result_sha256: string }
interface PriorResultRow extends RowDataPacket { status: BridgeCommandResultEnvelope['payload']['status'] }
interface RecoverableCommandRow extends CommandRow { result_json: string | Record<string, unknown> | null }
interface CountRow extends RowDataPacket { status: string; quantity: number }
interface TradeStateRow extends RowDataPacket {
  terminal_instance_id: string; connection_epoch: string | number; projection_revision: string | number
  state_json: string | Record<string, unknown>; state_sha256: string
}

const commandColumns = `c.id,c.execution_intent_id,c.command_sequence,c.user_id,c.trading_account_id,
  c.terminal_profile_id,c.terminal_instance_id,c.broker_server,c.account_login,c.connection_epoch,
  c.action,c.idempotency_key,c.request_sha256,c.status,c.issued_at_utc,c.deadline_at_utc,c.dispatched_at_utc,
  c.accepted_at_utc,c.completed_at_utc,c.error_code,c.terminal_code,c.result_sha256,c.result_message_id,
  c.revision,c.created_at_utc,c.updated_at_utc,p.request_envelope_json`
const commandTables = `FROM bridge_commands_v4 c INNER JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id`
const selectCommand = `SELECT ${commandColumns} ${commandTables}`

export type CapturePartialCloseRegistration = (command: BridgeCommand) => Promise<
  (connection: PoolConnection, plan: PartialCloseProtectionPlan) => Promise<void>>

export class MysqlBridgeCommandRepository implements BridgeCommandRepository {
  constructor(private readonly pool: Pool, private readonly accountClock: (connection: PoolConnection) => AccountClockReader, private readonly riskPolicy: (connection: PoolConnection) => RiskDispatchPolicyReader,
    private readonly capturePartialCloseRegistration?: CapturePartialCloseRegistration,
    private readonly capturePositionProtection?: CapturePositionProtectionCommandProvider,
    private readonly captureProtectionDispatch?: CapturePositionProtectionDispatch,
    private readonly capturePartialCloseDispatch?: CapturePartialCloseParentDispatch,
    private readonly strategyConfig?: (connection: PoolConnection) => StrategyExecutionConfigReader,
    private readonly pendingReviewer?: (connection: PoolConnection) => PendingCommandReviewer) {}

  async create(command: BridgeCommand) {
    const register = command.action === 'position.close' && this.capturePartialCloseRegistration
      ? await this.capturePartialCloseRegistration(command) : undefined
    const protection = command.action === 'position.protection.set' && this.capturePositionProtection
      ? await this.capturePositionProtection(command) : undefined
    return transaction(this.pool, async connection => {
      await lockAccount(connection, command.accountId)
      const [existingRows] = await connection.execute<CommandRow[]>(`${selectCommand} WHERE c.execution_intent_id=? AND c.command_sequence=? LIMIT 1 FOR UPDATE`, [command.executionIntentId, command.commandSequence])
      const existing = existingRows[0]
      if (existing) {
        const mapped = mapCommand(existing)
        if (!bridgeCommandInputMatches(mapped, {
          executionIntentId: command.executionIntentId, commandSequence: command.commandSequence,
          userId: command.userId, accountId: command.accountId, terminalProfileId: command.terminalProfileId,
          route: command.route, action: command.action, params: command.request.payload.params,
          expectedState: command.request.payload.expected_state, deadlineAt: command.deadlineAt,
        })) {
          throw new BridgeCommandError('bridge_command_idempotency_conflict', 409)
        }
        if (mapped.action === 'position.close') {
          const intent = await lockIntent(connection, mapped.executionIntentId)
          const sourceAction = await readCommandSourceAction(connection, intent.id)
          const plan = buildPartialClosePlan(mapped, sourceAction, intent.expires_at_utc.getTime())
          if (plan) {
            if (!register) throw new BridgeCommandError('partial_close_workflow_unavailable', 409)
            await register(connection, plan)
          }
        }
        if (mapped.action === 'position.protection.set') {
          const intent = await lockIntent(connection,mapped.executionIntentId)
          if (intent.source_type === 'position_workflow') {
            if (!protection) throw new BridgeCommandError('position_protection_command_binding_unavailable',409)
            await protection.replay(connection,mapped,intent.source_id)
          }
        }
        return mapped
      }
      const [activeRows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM bridge_commands_v4
        WHERE trading_account_id=? AND execution_intent_id<>?
          AND status IN ('queued','dispatched','accepted','uncertain','reconciling')
        LIMIT 1 FOR UPDATE`, [command.accountId, command.executionIntentId])
      if (activeRows[0]) throw new BridgeCommandError('bridge_account_command_inflight', 409)
      await lockExactRoute(connection, command)
      const intent = await lockIntent(connection, command.executionIntentId)
      if (intent.source_type === 'position_workflow' && !protection) throw new BridgeCommandError('position_protection_command_binding_unavailable',409)
      if (intent.user_id !== command.userId || String(intent.trading_account_id) !== command.accountId
        || intent.status !== 'prepared' || intent.expires_at_utc.getTime() <= Date.parse(command.issuedAt)
        || Date.parse(command.deadlineAt) > intent.expires_at_utc.getTime() || bridgeAction(intent.action_kind) !== command.action) {
        throw new BridgeCommandError('bridge_command_intent_not_prepared', 409)
      }
      const sourceAction = await readCommandSourceAction(connection, intent.id)
      const plan = buildPartialClosePlan(command, sourceAction, intent.expires_at_utc.getTime())
      if (plan && !register) throw new BridgeCommandError('partial_close_workflow_unavailable', 409)
      assertCommandMatchesIntent(command, sourceAction)
      let authority: PositionProtectionCommandReview | undefined
      if (intent.source_type === 'position_workflow') authority = await protection!.authorize(connection,command,intent.source_id)
      await assertExpectedStateMatchesSnapshot(connection, command, authority?.action ?? sourceAction)
      if (command.action === 'order.place' && sourceAction.kind === 'pending_order') {
        await this.reviewOrder(connection, command, new Date(command.issuedAt), intent.source_type)
      }
      await connection.execute(`INSERT INTO bridge_commands_v4
        (id,execution_intent_id,command_sequence,user_id,trading_account_id,terminal_profile_id,terminal_instance_id,broker_server,account_login,connection_epoch,action,idempotency_key,request_sha256,status,issued_at_utc,deadline_at_utc,dispatched_at_utc,accepted_at_utc,completed_at_utc,error_code,terminal_code,result_sha256,result_message_id,revision,created_at_utc,updated_at_utc)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,?,?)`, [
        command.id, command.executionIntentId, command.commandSequence, command.userId, command.accountId,
        command.terminalProfileId, command.route.terminalInstanceId, command.route.brokerServer, command.route.login,
        command.route.connectionEpoch, command.action, command.idempotencyKey, command.requestHash,
        bridgeCommandSqlTime(command.issuedAt), bridgeCommandSqlTime(command.deadlineAt), bridgeCommandSqlTime(command.createdAt), bridgeCommandSqlTime(command.updatedAt),
      ])
      const paramsJson = JSON.stringify(command.request.payload.params)
      const expectedJson = command.request.payload.expected_state === null ? null : JSON.stringify(command.request.payload.expected_state)
      const envelopeJson = JSON.stringify(command.request)
      await connection.execute(`INSERT INTO bridge_command_payloads_v4 (bridge_command_id,params_json,expected_state_json,request_envelope_json,payload_bytes) VALUES (?,?,?,?,?)`, [
        command.id, paramsJson, expectedJson, envelopeJson,
        Buffer.byteLength(paramsJson) + (expectedJson ? Buffer.byteLength(expectedJson) : 0) + Buffer.byteLength(envelopeJson),
      ])
      if (plan) await register!(connection, plan)
      if (authority) await protection!.bind(connection,command,authority)
      await commandEvent(connection, command.id, 'bridge.command.queued', null, 'queued', null, null, 1, command.requestHash, command.createdAt)
      await connection.execute(`INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
        VALUES (?,?,?,'bridge.command.queued',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [
        randomUUID(), 'bridge_command', command.id,
        JSON.stringify({ command_id: command.id, trading_account_id: command.accountId }),
      ])
      return command
    })
  }

  async get(commandId: string) {
    return readStoredBridgeCommand(this.pool, commandId)
  }

  async markDispatched(commandId: string, expectedRevision: number, now: string) {
    const candidate = this.captureProtectionDispatch || this.capturePartialCloseDispatch ? await this.get(commandId) : null
    const protection = candidate?.action === 'position.protection.set' && this.captureProtectionDispatch
      ? await this.captureProtectionDispatch!(candidate) : undefined
    const parent = candidate?.action === 'position.close' && this.capturePartialCloseDispatch
      ? await this.capturePartialCloseDispatch(candidate) : undefined
    return this.locked(commandId, async (connection, command, intent) => {
      if (intent.source_type === 'position_workflow' && !protection) throw new BridgeCommandError('position_protection_dispatch_unavailable', 409)
      if (command.status !== 'queued' || command.revision !== expectedRevision) conflict()
      if (intent.source_type === 'position_workflow') {
        if (intent.status !== 'prepared') conflict()
        now = await protection!(connection, command, intent.source_id)
      }
      if (Date.parse(command.deadlineAt) <= Date.parse(now)) throw new BridgeCommandError('bridge_command_deadline_expired', 409)
      if (command.action === 'position.close') {
        const source = await readCommandSourceAction(connection, intent.id)
        if (Object.hasOwn(source.parameters, 'after_close_protection') || Object.hasOwn(source.parameters, 'after_close_target')) {
          if (!parent) throw new BridgeCommandError('partial_close_workflow_dispatch_unavailable', 409)
          if (intent.status !== 'prepared') conflict()
          now = await parent(connection, command, source, intent.expires_at_utc.getTime())
        }
      }
      if (intent.source_type === 'risk_decision' || intent.source_type === 'strategy_distribution') {
        try {
          if (intent.source_type === 'risk_decision') await assertRiskDecisionWindow(this.accountClock(connection), connection,
            intent.source_id, intent.user_id, intent.trading_account_id, new Date(), this.strategyConfig?.(connection))
          else await assertDistributionWindow(this.accountClock(connection), connection, intent.source_id, intent.user_id, intent.trading_account_id, new Date())
        }
        catch (error) {
          if (error instanceof ExecutionError) throw new BridgeCommandError(error.code, 409)
          throw error
        }
      }
      if (command.action === 'order.place') {
        await this.reviewOrder(connection, command, new Date(now), intent.source_type)
      }
      const next = await moveCommand(connection, command, 'dispatched', now, null, { dispatched: now })
      await moveIntent(connection, intent, 'dispatching', now, null)
      await refreshOperation(connection, intent.operation_id, now)
      return next
    }, true)
  }

  async markAccepted(envelope: BridgeCommandAcceptedEnvelope, now: string) {
    return this.locked(envelope.payload.command_id, async (connection, command, intent) => {
      if (!routeMatches(command, envelope.route)) throw new BridgeCommandError('bridge_command_route_mismatch', 409)
      if (['accepted', 'succeeded', 'rejected', 'failed', 'reconciling'].includes(command.status)) return command
      if (command.status === 'uncertain' && command.resultHash) return command
      if (command.status !== 'dispatched' && command.status !== 'uncertain') conflict()
      const next = await moveCommand(connection, command, 'accepted', now, null, { accepted: new Date(envelope.payload.accepted_at_utc_msc).toISOString() })
      await moveIntent(connection, intent, 'awaiting_result', now, null)
      await refreshOperation(connection, intent.operation_id, now)
      return next
    })
  }

  private async reviewOrder(connection: PoolConnection, command: BridgeCommand, now: Date, sourceType?: string) {
    try {
      const policy = await this.riskPolicy(connection).getEffectivePolicy(command.userId, command.accountId)
      assertOrderDispatchPolicy(command, policy, { skipForManual: sourceType === 'user_command' })
      if (command.request.payload.params.order_type !== 'market') {
        if (!this.pendingReviewer) throw new BridgeCommandError('execution_pending_review_unavailable', 409)
        await this.pendingReviewer(connection).review(command, policy, now)
      }
    } catch (error) {
      if (error instanceof RiskError) throw new BridgeCommandError('execution_dispatch_policy_unavailable', 409)
      if (error instanceof ExecutionError) throw new BridgeCommandError(error.code, 409)
      throw error
    }
  }

  async markPreDispatchFailed(commandId: string, expectedRevision: number, errorCode: string, now: string) {
    return this.locked(commandId, async (connection, command, intent) => {
      if (command.status !== 'queued' || command.revision !== expectedRevision) conflict()
      const next = await moveCommand(connection, command, 'failed', now, errorCode, { completed: now })
      await moveIntent(connection, intent, 'failed', now, errorCode, true)
      await settleReservation(connection, intent.id, 'released', errorCode, now)
      await refreshOperation(connection, intent.operation_id, now)
      return next
    })
  }

  async markUncertain(commandId: string, expectedRevision: number, errorCode: string, now: string) {
    return this.locked(commandId, async (connection, command, intent) => {
      if (!['dispatched', 'accepted', 'reconciling'].includes(command.status) || command.revision !== expectedRevision) conflict()
      const next = await moveCommand(connection, command, 'uncertain', now, errorCode)
      await moveIntent(connection, intent, 'uncertain', now, errorCode)
      await refreshOperation(connection, intent.operation_id, now)
      return next
    })
  }

  async persistResult(envelope: BridgeCommandResultEnvelope, resultHash: string, now: string): Promise<BridgeResultPersistence> {
    return this.locked(envelope.payload.command_id, async (connection, command, intent) => {
      if (!routeContinues(command, envelope.route) || envelope.payload.action !== command.action) throw new BridgeCommandError('bridge_command_result_route_mismatch', 409)
      const [messageRows] = await connection.execute<ExistingResultRow[]>('SELECT bridge_command_id,result_sha256 FROM bridge_command_results_v4 WHERE message_id=? LIMIT 1 FOR UPDATE', [envelope.message_id])
      if (messageRows[0]) {
        if (messageRows[0].bridge_command_id !== command.id || messageRows[0].result_sha256 !== resultHash) throw new BridgeCommandError('bridge_command_result_message_conflict', 409)
        return { command, disposition: 'duplicate' }
      }
      if (command.resultHash === resultHash) return { command, disposition: 'duplicate' }
      let priorResultStatus: BridgeCommandResultEnvelope['payload']['status'] | null = null
      if (command.resultHash !== null) {
        const [priorRows] = await connection.execute<PriorResultRow[]>(
          'SELECT status FROM bridge_command_results_v4 WHERE bridge_command_id=? AND result_sha256=? ORDER BY id DESC LIMIT 1 FOR UPDATE',
          [command.id, command.resultHash],
        )
        priorResultStatus = priorRows[0]?.status ?? null
      }
      const reconciledTerminalResult = command.resultHash !== null
        && command.status === 'reconciling'
        && priorResultStatus === 'uncertain'
      const conflictResult = command.resultHash !== null && command.resultHash !== resultHash && !reconciledTerminalResult
      await connection.execute(`INSERT INTO bridge_command_results_v4 (bridge_command_id,message_id,result_sha256,action,status,result_json,error_code,terminal_code,completed_at_utc,received_at_utc,conflict) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        command.id, envelope.message_id, resultHash, envelope.payload.action, envelope.payload.status,
        envelope.payload.result === null ? null : JSON.stringify(envelope.payload.result), envelope.payload.error_code,
        envelope.payload.terminal_code === undefined || envelope.payload.terminal_code === null ? null : String(envelope.payload.terminal_code),
        bridgeCommandSqlTime(new Date(envelope.payload.completed_at_utc_msc).toISOString()), bridgeCommandSqlTime(now), conflictResult ? 1 : 0,
      ])
      if (conflictResult) {
        const next = await moveCommand(connection, command, 'uncertain', now, 'bridge_result_conflict', {}, resultHash)
        if (intent.status !== 'uncertain') await moveIntent(connection, intent, 'uncertain', now, 'bridge_result_conflict')
        await persistExecutionOutcome(connection, intent, envelope, resultHash, 'uncertain', now)
        await holdReservationForConflict(connection, intent.id, now)
        await refreshOperation(connection, intent.operation_id, now)
        if (intent.source_type === 'position_workflow') await wakePositionProtectionResult(connection, next, intent.source_id)
        await wakePartialCloseResult(connection, next)
        return { command: next, disposition: 'conflict' }
      }
      if (!['dispatched', 'accepted', 'uncertain', 'reconciling'].includes(command.status)) conflict()
      const completed = new Date(envelope.payload.completed_at_utc_msc).toISOString()
      const next = await moveCommand(connection, command, envelope.payload.status, now, envelope.payload.error_code,
        { completed, terminalCode: envelope.payload.terminal_code ?? null, resultHash, resultMessageId: envelope.message_id }, resultHash)
      await moveIntent(connection, intent, envelope.payload.status, now, envelope.payload.error_code,
        envelope.payload.status !== 'uncertain', completed)
      await persistExecutionOutcome(connection, intent, envelope, resultHash, envelope.payload.status, now)
      if (envelope.payload.status === 'succeeded') await settleReservation(connection, intent.id, 'committed', null, now)
      if (envelope.payload.status === 'rejected' || envelope.payload.status === 'failed') await settleReservation(connection, intent.id, 'released', envelope.payload.error_code ?? `bridge_${envelope.payload.status}`, now)
      await refreshOperation(connection, intent.operation_id, now)
      if (intent.source_type === 'position_workflow') await wakePositionProtectionResult(connection, next, intent.source_id)
      await wakePartialCloseResult(connection, next)
      return { command: next, disposition: 'persisted' }
    }, false, envelope.route)
  }

  async beginReconciliation(commandId: string, expectedRevision: number, now: string) {
    return this.locked(commandId, async (connection, command, intent) => {
      if (command.status !== 'uncertain' || command.revision !== expectedRevision) conflict()
      if (command.errorCode === 'bridge_result_conflict') throw new BridgeCommandError('bridge_command_conflict_manual_review_required', 409)
      const next = await moveCommand(connection, command, 'reconciling', now, null)
      if (intent.status !== 'reconciling') await moveIntent(connection, intent, 'reconciling', now, null)
      return next
    })
  }

  async listReconciliationCandidates(accountId: string, route: BridgeCommand['route'], limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BridgeCommandError('bridge_command_reconcile_limit_invalid', 422)
    const [rows] = await this.pool.execute<RecoverableCommandRow[]>(`SELECT ${commandColumns},r.result_json ${commandTables}
      LEFT JOIN bridge_command_results_v4 r ON r.id=(
        SELECT r2.id FROM bridge_command_results_v4 r2
        WHERE r2.bridge_command_id=c.id AND r2.result_sha256=c.result_sha256
        ORDER BY r2.id DESC LIMIT 1
      )
      WHERE c.trading_account_id=? AND c.status IN ('dispatched','accepted','uncertain','reconciling')
        AND c.terminal_instance_id=? AND BINARY c.broker_server=BINARY ? AND BINARY c.account_login=BINARY ?
        AND c.connection_epoch<=?
      ORDER BY c.updated_at_utc,c.id LIMIT ?`, [
      accountId, route.terminalInstanceId, route.brokerServer, route.login, route.connectionEpoch, limit,
    ])
    return rows.map(row => {
      const command = mapCommand(row)
      const result = row.result_json === null ? null : parse<Record<string, unknown>>(row.result_json)
      return { command, terminalTicket: bridgeReconciliationTicket(command, result) }
    })
  }

  private async locked<T>(commandId: string, work: (connection: PoolConnection, command: BridgeCommand, intent: IntentRow) => Promise<T>, requireCurrentRoute = false, resultRoute: BridgeWireRoute | null = null) {
    const [locatorRows] = await this.pool.execute<CommandLocator[]>('SELECT id,CAST(trading_account_id AS CHAR) trading_account_id,execution_intent_id FROM bridge_commands_v4 WHERE id=? LIMIT 1', [commandId])
    const locator = locatorRows[0]
    if (!locator) throw new BridgeCommandError('bridge_command_not_found', 404)
    const routeCandidate = requireCurrentRoute || resultRoute ? await this.get(commandId) : null
    if ((requireCurrentRoute || resultRoute) && !routeCandidate) throw new BridgeCommandError('bridge_command_not_found', 404)
    return transaction(this.pool, async connection => {
      await lockAccount(connection, locator.trading_account_id)
      if (routeCandidate && requireCurrentRoute) await lockExactRoute(connection, routeCandidate)
      if (routeCandidate && resultRoute) await lockResultRoute(connection, routeCandidate, resultRoute)
      const intent = await lockIntent(connection, locator.execution_intent_id)
      const [rows] = await connection.execute<CommandRow[]>(`${selectCommand} WHERE c.id=? LIMIT 1 FOR UPDATE`, [commandId])
      if (!rows[0]) throw new BridgeCommandError('bridge_command_not_found', 404)
      return work(connection, mapCommand(rows[0]), intent)
    })
  }
}

async function lockExactRoute(connection: PoolConnection, command: BridgeCommand) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM trading_accounts a
    INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL
    INNER JOIN terminal_profiles p ON p.id=? AND p.user_id=? AND p.deleted_at_utc IS NULL
    INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.terminal_profile_id=p.id AND b.terminal_instance_id=? AND b.unbound_at_utc IS NULL
    INNER JOIN bridge_connection_sessions s ON s.trading_account_id=a.id AND s.user_id=? AND s.terminal_profile_id=b.terminal_profile_id AND s.terminal_instance_id=b.terminal_instance_id AND s.connection_epoch_v4=? AND s.disconnected_at_utc IS NULL
    INNER JOIN account_runtime_snapshots snap ON snap.trading_account_id=a.id AND snap.trade_permission=1
    WHERE a.id=? AND BINARY a.broker_server=BINARY ? AND BINARY a.account_login=BINARY ? AND a.deleted_at_utc IS NULL FOR UPDATE`, [
    command.userId, command.terminalProfileId, command.userId, command.route.terminalInstanceId, command.userId, command.route.connectionEpoch,
    command.accountId, command.route.brokerServer, command.route.login,
  ])
  if (!rows[0]) throw new BridgeCommandError('bridge_command_route_unavailable', 409)
}

async function lockResultRoute(connection: PoolConnection, command: BridgeCommand, route: BridgeWireRoute) {
  if (!routeContinues(command, route)) throw new BridgeCommandError('bridge_command_result_route_mismatch', 409)
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT s.id FROM bridge_connection_sessions s
    INNER JOIN terminal_profiles p ON p.id=s.terminal_profile_id AND p.user_id=s.user_id AND p.deleted_at_utc IS NULL
    WHERE s.user_id=? AND s.trading_account_id=? AND s.terminal_profile_id=? AND s.terminal_instance_id=?
      AND s.connection_epoch_v4=? AND s.disconnected_at_utc IS NULL FOR UPDATE`, [
    command.userId, command.accountId, command.terminalProfileId, route.terminal_instance_id, route.connection_epoch,
  ])
  if (!rows[0]) throw new BridgeCommandError('bridge_command_result_session_invalid', 409)
}

async function lockAccount(connection: PoolConnection, accountId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? AND deleted_at_utc IS NULL FOR UPDATE', [accountId])
  if (!rows[0]) throw new BridgeCommandError('bridge_command_account_not_found', 404)
}

async function lockIntent(connection: PoolConnection, intentId: string) {
  const [rows] = await connection.execute<IntentRow[]>('SELECT id,operation_id,user_id,CAST(trading_account_id AS CHAR) trading_account_id,action_kind,source_type,source_id,status,revision,expires_at_utc FROM execution_intents WHERE id=? LIMIT 1 FOR UPDATE', [intentId])
  if (!rows[0]) throw new BridgeCommandError('bridge_command_intent_not_found', 404)
  return rows[0]
}

async function persistExecutionOutcome(
  connection: PoolConnection,
  intent: IntentRow,
  envelope: BridgeCommandResultEnvelope,
  resultHash: string,
  status: BridgeCommandResultEnvelope['payload']['status'],
  now: string,
) {
  const terminalResult = envelope.payload.result
  const { ticket, resourceKind } = executionOutcomeReference(intent.action_kind, status, terminalResult)
  const distributionTargetId = ['strategy_distribution', 'distribution_close'].includes(intent.source_type)
    ? intent.source_id
    : null
  const completedAt = status === 'uncertain' ? null : new Date(envelope.payload.completed_at_utc_msc).toISOString()
  await connection.execute(`INSERT INTO execution_outcomes
    (id,execution_intent_id,distribution_target_id,trading_account_id,resource_kind,ticket,result_sha256,status,result_json,confirmed_at_utc,created_at_utc,updated_at_utc,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
    ON DUPLICATE KEY UPDATE distribution_target_id=VALUES(distribution_target_id),resource_kind=VALUES(resource_kind),ticket=VALUES(ticket),
      result_sha256=VALUES(result_sha256),status=VALUES(status),result_json=VALUES(result_json),confirmed_at_utc=VALUES(confirmed_at_utc),
      updated_at_utc=VALUES(updated_at_utc),revision=revision+1`, [
    randomUUID(), intent.id, distributionTargetId, intent.trading_account_id, resourceKind, ticket, resultHash, status,
    terminalResult === null ? null : JSON.stringify(terminalResult), completedAt === null ? null : bridgeCommandSqlTime(completedAt), bridgeCommandSqlTime(now), bridgeCommandSqlTime(now),
  ])
}

async function moveCommand(connection: PoolConnection, command: BridgeCommand, status: BridgeCommand['status'], now: string,
  errorCode: string | null, fields: { dispatched?: string; accepted?: string; completed?: string; terminalCode?: string | number | null; resultHash?: string; resultMessageId?: string } = {}, evidenceHash: string | null = null) {
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE bridge_commands_v4 SET status=?,dispatched_at_utc=COALESCE(?,dispatched_at_utc),accepted_at_utc=COALESCE(?,accepted_at_utc),completed_at_utc=COALESCE(?,completed_at_utc),error_code=?,terminal_code=COALESCE(?,terminal_code),result_sha256=COALESCE(?,result_sha256),result_message_id=COALESCE(?,result_message_id),updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [
    status, fields.dispatched === undefined ? null : bridgeCommandSqlTime(fields.dispatched),
    fields.accepted === undefined ? null : bridgeCommandSqlTime(fields.accepted), fields.completed === undefined ? null : bridgeCommandSqlTime(fields.completed), errorCode,
    fields.terminalCode === undefined || fields.terminalCode === null ? null : String(fields.terminalCode), fields.resultHash ?? null,
    fields.resultMessageId ?? null, bridgeCommandSqlTime(now), command.id, command.revision,
  ])
  if (result.affectedRows !== 1) conflict()
  await commandEvent(connection, command.id, `bridge.command.${status}`, command.status, status, errorCode, command.revision, command.revision + 1, evidenceHash, now)
  const [rows] = await connection.execute<CommandRow[]>(`${selectCommand} WHERE c.id=? LIMIT 1`, [command.id])
  return mapCommand(rows[0]!)
}

async function moveIntent(connection: PoolConnection, intent: IntentRow, status: string, now: string, errorCode: string | null, terminal = false, completedAt = now) {
  const [result] = await connection.execute<ResultSetHeader>('UPDATE execution_intents SET status=?,error_code=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, errorCode, bridgeCommandSqlTime(now), terminal ? bridgeCommandSqlTime(completedAt) : null, intent.id, intent.revision])
  if (result.affectedRows !== 1) conflict()
  await connection.execute(`INSERT INTO execution_intent_events (execution_intent_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,?,?,?,?,?,JSON_OBJECT(),?)`, [intent.id, `execution.intent.${status}`, intent.status, status, errorCode, intent.revision, intent.revision + 1, bridgeCommandSqlTime(now)])
  intent.status = status; intent.revision += 1
}

async function settleReservation(connection: PoolConnection, intentId: string, status: 'committed' | 'released', reason: string | null, now: string) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string; revision: number })[]>('SELECT id,revision FROM risk_reservations_v4 WHERE execution_intent_id=? AND status=\'active\' LIMIT 1 FOR UPDATE', [intentId])
  const row = rows[0]; if (!row) return
  const released = status === 'released' ? bridgeCommandSqlTime(now) : null
  await connection.execute('UPDATE risk_reservations_v4 SET status=?,released_at_utc=?,release_reason=?,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, released, reason, bridgeCommandSqlTime(now), row.id, row.revision])
  await connection.execute(`INSERT INTO risk_reservation_events_v4 (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc) VALUES (?,?, 'active',?,?,?,?,?)`, [row.id, `risk.reservation.${status}`, status, reason, row.revision, row.revision + 1, bridgeCommandSqlTime(now)])
}

async function holdReservationForConflict(connection: PoolConnection, intentId: string, now: string) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string; status: string; revision: number })[]>('SELECT id,status,revision FROM risk_reservations_v4 WHERE execution_intent_id=? LIMIT 1 FOR UPDATE', [intentId])
  const row = rows[0]
  if (!row || row.status === 'active') return
  await connection.execute(`UPDATE risk_reservations_v4 SET status='active',released_at_utc=NULL,release_reason=NULL,updated_at_utc=?,revision=revision+1 WHERE id=? AND revision=?`, [bridgeCommandSqlTime(now), row.id, row.revision])
  await connection.execute(`INSERT INTO risk_reservation_events_v4 (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc) VALUES (?,'risk.reservation.reactivated',?,'active','bridge_result_conflict',?,?,?)`, [row.id, row.status, row.revision, row.revision + 1, bridgeCommandSqlTime(now)])
}

async function assertExpectedStateMatchesSnapshot(connection: PoolConnection, command: BridgeCommand, action: ExecutionAction) {
  if (command.action === 'order.place') return
  const expected = command.request.payload.expected_state
  const ticket = command.request.payload.params.ticket
  if (!expected || typeof ticket !== 'string') mismatch()
  const entityKind = command.action.startsWith('position.') ? 'position' : 'pending_order'
  const revisionKey = entityKind === 'position' ? 'positionsRevision' : 'pendingOrdersRevision'
  const sourceRevision = action.expectedState[revisionKey]
  if (typeof sourceRevision !== 'number' || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) mismatch()
  const [rows] = await connection.execute<TradeStateRow[]>(`SELECT terminal_instance_id,connection_epoch,projection_revision,state_json,state_sha256
    FROM bridge_trade_state_snapshots_v4
    WHERE trading_account_id=? AND entity_kind=? AND ticket=? LIMIT 1 FOR UPDATE`, [command.accountId, entityKind, ticket])
  const row = rows[0]
  const state = row ? parse<Record<string, unknown>>(row.state_json) : null
  const unchangedUserState = state && Number(row?.projection_revision) > Number(sourceRevision)
    && await unchangedUserCommandTradeState(connection, command.executionIntentId, state)
  if (!row || row.terminal_instance_id !== command.route.terminalInstanceId
    || Number(row.connection_epoch) !== command.route.connectionEpoch
    || (Number(row.projection_revision) !== Number(sourceRevision) && !unchangedUserState)
    || !state || sha256Canonical(state) !== row.state_sha256
    || sha256Canonical(state) !== sha256Canonical(expected)) mismatch()
}

async function refreshOperation(connection: PoolConnection, operationId: string, now: string) {
  const [rows] = await connection.execute<CountRow[]>('SELECT status,COUNT(*) quantity FROM execution_intents WHERE operation_id=? GROUP BY status FOR UPDATE', [operationId])
  const counts = new Map(rows.map(row => [row.status, Number(row.quantity)]))
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  const success = counts.get('succeeded') ?? 0
  const active = ['preparing', 'risk_pending', 'prepared', 'dispatching', 'awaiting_result', 'reconciling'].some(status => counts.has(status))
  const uncertain = (counts.get('uncertain') ?? 0) > 0
  let status = uncertain ? 'uncertain' : active ? 'running' : success === total ? 'succeeded'
    : success > 0 ? 'partially_succeeded' : (counts.get('rejected') ?? 0) > 0 ? 'rejected' : 'failed'
  const terminal = !['running', 'uncertain'].includes(status)
  const [operationRows] = await connection.execute<(RowDataPacket & { status: string; revision: number })[]>('SELECT status,revision FROM operations WHERE id=? LIMIT 1 FOR UPDATE', [operationId])
  const current = operationRows[0]; if (!current) return
  if (current.status !== status) {
    await connection.execute('UPDATE operations SET status=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, bridgeCommandSqlTime(now), terminal ? bridgeCommandSqlTime(now) : null, operationId, current.revision])
    await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,?,?,NULL,?,?,JSON_OBJECT(),?)`, [operationId, `operation.${status}`, current.status, status, current.revision, current.revision + 1, bridgeCommandSqlTime(now)])
    await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,'operation.changed',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), 'operation', operationId, JSON.stringify({ operation_id: operationId, status, revision: String(current.revision + 1), updated_at: now })])
  }
  await refreshDistributionTargetFromChild(connection, operationId, status, now)
}

async function refreshDistributionTargetFromChild(connection: PoolConnection, childOperationId: string, childStatus: string, now: string) {
  const [targetRows] = await connection.execute<(RowDataPacket & { id: string; distribution_id: string; status: string; revision: number })[]>('SELECT id,distribution_id,status,revision FROM execution_distribution_targets WHERE child_operation_id=? LIMIT 1 FOR UPDATE', [childOperationId])
  const target = targetRows[0]
  if (!target) return
  const targetStatus = distributionTargetStatus(childStatus)
  if (target.status !== targetStatus) {
    const terminal = !['queued', 'running', 'uncertain'].includes(targetStatus)
    await connection.execute('UPDATE execution_distribution_targets SET status=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [targetStatus, bridgeCommandSqlTime(now), terminal ? bridgeCommandSqlTime(now) : null, target.id, target.revision])
  }
  await refreshDistributionParent(connection, target.distribution_id, now)
}

async function refreshDistributionParent(connection: PoolConnection, distributionId: string, now: string) {
  const [countRows] = await connection.execute<CountRow[]>('SELECT status,COUNT(*) quantity FROM execution_distribution_targets WHERE distribution_id=? GROUP BY status FOR UPDATE', [distributionId])
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
  const status = uncertain > 0 ? 'uncertain'
    : running > 0 || (queued > 0 && queued < total) ? 'running'
      : queued === total ? 'queued'
        : succeeded === total ? 'succeeded'
          : succeeded > 0 ? 'partially_succeeded'
            : rejected === total ? 'rejected'
              : 'failed'
  const terminal = !['queued', 'running', 'uncertain'].includes(status)
  const summary = { target_count: total, queued_targets: queued, running_targets: running, succeeded_targets: succeeded, rejected_targets: rejected, failed_targets: failed, uncertain_targets: uncertain, cancelled_targets: cancelled, expired_targets: expired }
  const [distributionRows] = await connection.execute<(RowDataPacket & { parent_operation_id: string; status: string; revision: number; result_summary_json: string | object })[]>('SELECT parent_operation_id,status,revision,result_summary_json FROM execution_distributions WHERE id=? LIMIT 1 FOR UPDATE', [distributionId])
  const distribution = distributionRows[0]
  if (!distribution) return
  const summaryJson = JSON.stringify(summary)
  if (distribution.status === status && JSON.stringify(parse(distribution.result_summary_json)) === summaryJson) return
  await connection.execute('UPDATE execution_distributions SET status=?,result_summary_json=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, summaryJson, bridgeCommandSqlTime(now), terminal ? bridgeCommandSqlTime(now) : null, distributionId, distribution.revision])
  const [parentRows] = await connection.execute<(RowDataPacket & { status: string; revision: number })[]>('SELECT status,revision FROM operations WHERE id=? LIMIT 1 FOR UPDATE', [distribution.parent_operation_id])
  const parent = parentRows[0]
  if (!parent) return
  await connection.execute('UPDATE operations SET status=?,result_summary_json=?,updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND revision=?', [status, summaryJson, bridgeCommandSqlTime(now), terminal ? bridgeCommandSqlTime(now) : null, distribution.parent_operation_id, parent.revision])
  await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,?,?,NULL,?,?,?,?)`, [distribution.parent_operation_id, `operation.${status}`, parent.status, status, parent.revision, parent.revision + 1, JSON.stringify({ distribution_id: distributionId, result_summary: summary }), bridgeCommandSqlTime(now)])
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,'operation.changed',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), 'operation', distribution.parent_operation_id, JSON.stringify({ operation_id: distribution.parent_operation_id, status, revision: String(parent.revision + 1), updated_at: now })])
}

function distributionTargetStatus(status: string) {
  if (status === 'succeeded') return 'succeeded'
  if (status === 'rejected') return 'rejected'
  if (status === 'uncertain') return 'uncertain'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'expired') return 'expired'
  if (status === 'failed' || status === 'partially_succeeded') return 'failed'
  return 'running'
}

async function commandEvent(connection: PoolConnection, id: string, type: string, from: string | null, to: string, reason: string | null,
  fromRevision: number | null, toRevision: number, evidenceHash: string | null, at: string) {
  await connection.execute(`INSERT INTO bridge_command_events_v4 (bridge_command_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,evidence_sha256,occurred_at_utc) VALUES (?,?,?,?,?,?,?,?,?)`, [id, type, from, to, reason, fromRevision, toRevision, evidenceHash, bridgeCommandSqlTime(at)])
}

export async function readStoredBridgeCommand(db: Pick<Pool, 'execute'>, commandId: string): Promise<BridgeCommand | null> {
  const [rows] = await db.execute<CommandRow[]>(`${selectCommand} WHERE c.id=? LIMIT 1`, [commandId])
  return rows[0] ? mapCommand(rows[0]) : null
}

function mapCommand(row: CommandRow): BridgeCommand {
  return {
    id: row.id, executionIntentId: row.execution_intent_id, commandSequence: Number(row.command_sequence),
    userId: Number(row.user_id), accountId: String(row.trading_account_id), terminalProfileId: row.terminal_profile_id,
    route: { terminalInstanceId: row.terminal_instance_id, brokerServer: row.broker_server, login: row.account_login, connectionEpoch: Number(row.connection_epoch) },
    action: row.action, idempotencyKey: row.idempotency_key, requestHash: row.request_sha256, status: row.status,
    issuedAt: utc(row.issued_at_utc)!, deadlineAt: utc(row.deadline_at_utc)!, dispatchedAt: utc(row.dispatched_at_utc),
    acceptedAt: utc(row.accepted_at_utc), completedAt: utc(row.completed_at_utc), errorCode: row.error_code,
    terminalCode: row.terminal_code, resultHash: row.result_sha256, resultMessageId: row.result_message_id,
    revision: Number(row.revision), createdAt: utc(row.created_at_utc)!, updatedAt: utc(row.updated_at_utc)!,
    request: parse(row.request_envelope_json),
  }
}
function parse<T>(value: string | T): T { return typeof value === 'string' ? JSON.parse(value) as T : value }
function utc(value: Date | null) { return value ? new Date(value).toISOString() : null }
function conflict(): never { throw new BridgeCommandError('bridge_command_revision_conflict', 409) }
function bridgeAction(kind: string): BridgeCommand['action'] | null {
  if (kind === 'market_order' || kind === 'pending_order') return 'order.place'
  if (kind === 'modify_position') return 'position.protection.set'
  if (kind === 'close_position') return 'position.close'
  if (kind === 'modify_order') return 'pending_order.modify'
  if (kind === 'cancel_order') return 'pending_order.cancel'
  return null
}

function assertCommandMatchesIntent(command: BridgeCommand, action: ExecutionAction) {
  if (bridgeAction(action.kind) !== command.action) throw new BridgeCommandError('bridge_command_intent_action_mismatch', 409)
  const source = action.parameters
  const target = command.request.payload.params
  const same = (sourceKey: string, targetKey = sourceKey) => source[sourceKey] === undefined || String(source[sourceKey]) === String(target[targetKey])
  const noUnexpected = (serverKeys: string[]) => Object.keys(target).every(key => serverKeys.includes(key) || source[key] !== undefined)
  switch (action.kind) {
    case 'market_order':
      if (target.order_type !== 'market' || !same('symbol') || !same('side', 'direction') || !same('volume')
        || !same('stop_loss') || !same('take_profit') || !noUnexpected(['direction', 'order_type', 'magic', 'deviation'])) mismatch()
      break
    case 'pending_order': {
      const direction = String(source.type ?? '').startsWith('buy_') ? 'buy' : 'sell'
      if (!same('symbol') || !same('type', 'order_type') || target.direction !== direction || !same('volume') || !same('price')
        || !same('stop_limit_price') || !same('stop_loss') || !same('take_profit') || !same('expiration_utc_msc')
        || !noUnexpected(['direction', 'order_type', 'magic', 'deviation'])) mismatch()
      break
    }
    case 'modify_position':
      if (!same('ticket') || !same('stop_loss') || !same('remove_stop_loss') || !same('take_profit') || !same('remove_take_profit')
        || !noUnexpected([])) mismatch()
      break
    case 'close_position':
      if (!same('ticket') || !same('volume') || !noUnexpected(['deviation'])) mismatch()
      break
    case 'modify_order':
      if (!same('ticket') || !same('price') || !same('stop_limit_price') || !same('stop_loss') || !same('remove_stop_loss')
        || !same('take_profit') || !same('remove_take_profit') || !same('expiration_utc_msc') || !same('remove_expiration')
        || !noUnexpected([])) mismatch()
      break
    case 'cancel_order':
      if (!same('ticket') || !noUnexpected([])) mismatch()
      break
  }
  if (command.request.payload.expected_state !== null && command.request.payload.expected_state.ticket !== target.ticket) mismatch()
}
function mismatch(): never { throw new BridgeCommandError('bridge_command_intent_payload_mismatch', 409) }
