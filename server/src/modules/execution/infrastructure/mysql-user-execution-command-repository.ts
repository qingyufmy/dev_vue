import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { sha256Canonical } from '../domain/execution.js'
import type { JsonObject } from '../../inference/domain/inference.js'
import {
  UserExecutionCommandError,
  type NormalizedUserExecutionCommand,
  type PreparedUserExecutionBundle,
  type RejectedUserExecutionCommandResult,
  type UserExecutionCommandResult,
  type UserExecutionExpectedRevisions,
  type UserExecutionIntent,
  type UserExecutionOperation,
  type UserExecutionRiskReservation,
} from '../domain/user-execution-command.js'
import type {
  LoadUserExecutionCommandContextInput,
  PersistUserExecutionCommandInput,
  UserExecutionCommandContext,
  UserExecutionCommandRepository,
  UserExecutionCurrentRevisions,
  UserExecutionIdempotencyLookupInput,
  UserExecutionIdempotencyMatch,
} from '../application/user-execution-command-ports.js'
import {
  DEFAULT_RISK_POLICY,
  resolveRiskPolicy,
  riskPolicyHash,
  type AccountRiskPolicyPatch,
  type AccountRiskSummary,
  type EffectiveRiskPolicy,
  type RiskInstrumentSnapshot,
  type RiskQuoteSnapshot,
  type RiskEvaluationResult,
} from '../../risk/domain/risk.js'
import type { ManualReleaseRuleCode, ManualRiskRelease } from '../../risk/domain/manual-risk-release.js'

/**
 * MySQL adapter for the user-command application port.
 *
 * The write path deliberately has one lock order: account -> ownership ->
 * idempotency row -> projections/resources -> append-only records.  It keeps
 * the transaction small and never calls Bridge, a broker, Redis, or a model.
 * The parent composition root is responsible for applying 011 before wiring
 * this adapter; this file does not execute DDL.
 */
export class MysqlUserExecutionCommandRepository implements UserExecutionCommandRepository {
  constructor(private readonly pool: Pool) {}

  async loadContext(input: LoadUserExecutionCommandContextInput): Promise<UserExecutionCommandContext | null> {
    const [accountRows] = await this.pool.execute<AccountIdentityRow[]>(`
      SELECT CAST(a.id AS CHAR) account_id,a.currency
      FROM trading_accounts a
      INNER JOIN trading_account_ownerships owner
        ON owner.trading_account_id=a.id AND owner.user_id=? AND owner.role='owner' AND owner.revoked_at_utc IS NULL
      WHERE a.id=? AND a.deleted_at_utc IS NULL
      LIMIT 1`, [input.userId, input.accountId])
    const account = accountRows[0]
    if (!account) return null
    const [contextRows] = await this.pool.execute<TradingContextRow[]>(`
      SELECT mode,read_only
      FROM trading_contexts
      WHERE user_id=?
      LIMIT 1`, [input.userId])
    const tradingContext = contextRows[0]

    const [runtimeRows] = await this.pool.execute<RuntimeSnapshotRow[]>(`
      SELECT revision,trade_permission,timezone_offset_minutes,clock_status,balance,equity,margin_amount,free_margin
      FROM account_runtime_snapshots
      WHERE trading_account_id=?
      LIMIT 1`, [input.accountId])
    const runtime = runtimeRows[0]
    const [positionRows] = await this.pool.execute<PayloadRevisionRow[]>(`
      SELECT ticket,payload_json,revision
      FROM open_position_snapshots
      WHERE trading_account_id=?
      ORDER BY ticket`, [input.accountId])
    const [pendingRows] = await this.pool.execute<PayloadRevisionRow[]>(`
      SELECT ticket,payload_json,revision
      FROM pending_order_snapshots
      WHERE trading_account_id=?
      ORDER BY ticket`, [input.accountId])
    const positions = positionRows.map(mapProjectionItem)
    const pendingOrders = pendingRows.map(mapProjectionItem)
    const target = input.ticket
      ? positions.find(item => String(item.ticket ?? '') === input.ticket) ?? pendingOrders.find(item => String(item.ticket ?? '') === input.ticket)
      : null
    const symbol = normalizeSymbol(input.symbol ?? (target && typeof target.symbol === 'string' ? target.symbol : null))

    const quote = await loadQuote(this.pool, input.accountId, symbol)
    const instrument = await loadInstrument(this.pool, input.accountId, symbol)
    const summary = await loadRiskSummary(this.pool, input.accountId, input.userId, runtime)
    const policy = await effectivePolicy(this.pool, input.userId, input.accountId)
    const manualRelease = await loadManualRelease(this.pool, input.userId, input.accountId)
    const currentRevisionsValue = await currentRevisions(this.pool, input.accountId, symbol, runtime?.revision ?? null, summary.revision)

    return {
      userId: input.userId,
      accountId: String(account.account_id),
      accountCurrency: String(account.currency ?? '').trim().toUpperCase(),
      owned: true,
      observer: tradingContext?.mode === 'observer' || Boolean(tradingContext?.read_only),
      tradePermission: Boolean(runtime?.trade_permission),
      policy,
      summary,
      manualRelease,
      quote,
      instrument,
      positions,
      pendingOrders,
      currentRevisions: currentRevisionsValue,
    }
  }

  async findByIdempotency(input: UserExecutionIdempotencyLookupInput): Promise<UserExecutionIdempotencyMatch | null> {
    const [rows] = await this.pool.execute<UserCommandWithOperationRow[]>(`${userCommandSelect}
      INNER JOIN trading_account_ownerships owner ON owner.trading_account_id=c.trading_account_id
        AND owner.user_id=c.user_id AND owner.role='owner' AND owner.revoked_at_utc IS NULL
      WHERE c.user_id=? AND c.trading_account_id=? AND c.idempotency_key=?
      LIMIT 1`, [input.userId, input.accountId, input.idempotencyKey])
    const row = rows[0]
    if (!row) return null
    const operation = mapOperation(row)
    const result = await loadStoredResult(this.pool, row, operation)
    return { operation, requestHash: row.request_sha256, result }
  }

  async persistCommand(input: PersistUserExecutionCommandInput): Promise<UserExecutionCommandResult> {
    return transaction(this.pool, async connection => {
      // Lock order starts at the owner account.  This serializes competing
      // commands for the account before any idempotency or projection reads.
      const account = await lockAccount(connection, input.command.userId, input.command.accountId)
      await lockOwner(connection, input.command.userId, input.command.accountId)
      await assertWritableContext(connection, input.command.userId)
      await assertTradePermission(connection, input.command.accountId, input.expected.accountRevision)
      const existing = await findIdempotencyOnConnection(connection, input.command.userId, input.command.accountId, input.command.idempotencyKey)
      if (existing) {
        if (existing.request_sha256 !== input.command.requestHash) throw new UserExecutionCommandError('idempotency_conflict', 409)
        const operation = mapOperation(existing)
        return loadStoredResult(connection, existing, operation)
      }

      const symbol = await assertCurrentState(connection, input.command, input.action, account.currency, input.expected)
      assertOperationIdentity(input)
      const operation = input.result.operation
      const now = operation.updatedAt
      const commandJson = JSON.stringify(input.command)
      const actionJson = JSON.stringify(input.action)
      const expectedStateJson = JSON.stringify(input.action.expectedState)
      const riskJson = JSON.stringify(input.riskEvaluation)
      const policy = await effectivePolicy(connection, input.command.userId, input.command.accountId)
      if (riskPolicyHash(policy) !== input.riskEvaluation.policyHash) {
        // Risk was evaluated against a policy that is no longer current.  It
        // is an ordinary deterministic rejection and must be audited.
        throw new UserExecutionCommandError('user_command_policy_revision_stale', 409)
      }
      if (input.result.kind === 'prepared') {
        await assertReservationCapacity(connection, input.command.accountId, policy, input.result.reservations, input.riskEvaluation)
      }

      await connection.execute(`
        INSERT INTO operations
          (id,user_id,trading_account_id,kind,status,source_type,source_id,idempotency_scope,idempotency_key,
           request_sha256,resource_type,resource_id,parent_operation_id,distribution_id,result_summary_json,error_code,
           accepted_at_utc,updated_at_utc,completed_at_utc,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        operation.id, operation.userId, operation.accountId, operation.kind, operation.status,
        operation.sourceType, operation.sourceId, operation.idempotencyScope, operation.idempotencyKey,
        operation.requestHash, operation.resourceType, operation.resourceId, operation.parentOperationId,
        operation.distributionId, JSON.stringify(operationSummary(input.result)), operation.errorCode,
        operation.acceptedAt, operation.updatedAt, operation.completedAt, operation.revision,
      ])
      await connection.execute(`
        INSERT INTO user_execution_commands
          (id,operation_id,user_id,trading_account_id,command_type,source_type,source_id,idempotency_key,
           request_sha256,request_json,action_json,expected_state_json,risk_evaluation_json,risk_status,reject_code,
           platform_policy_version_id,account_policy_version_id,policy_set_revision,policy_sha256,account_revision,
           positions_revision,pending_orders_revision,quote_revision,contract_revision,risk_revision,manual_release_id,
           created_at_utc,updated_at_utc,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        input.command.commandId, operation.id, input.command.userId, input.command.accountId, input.command.commandType,
        input.command.sourceType, input.command.sourceId, input.command.idempotencyKey, input.command.requestHash,
        commandJson, actionJson, expectedStateJson, riskJson, input.result.kind === 'prepared' ? 'approved' : 'rejected',
        operation.errorCode, numericId(policy.platformPolicyVersionId), nullableNumericId(policy.accountPolicyVersionId),
        policy.policySetRevision, policyHashFromEvaluation(input.riskEvaluation), input.expected.accountRevision,
        input.expected.positionsRevision, input.expected.pendingOrdersRevision, input.expected.quoteRevision,
        input.expected.contractRevision, input.expected.riskRevision, input.riskEvaluation.manualReleaseId,
        operation.acceptedAt, operation.updatedAt, operation.revision,
      ])

      if (input.result.kind === 'prepared') {
        await insertPrepared(connection, input.result, input.riskEvaluation)
      }
      await insertOperationEvent(connection, operation, input.result.kind === 'prepared' ? 'operation.queued' : 'operation.rejected')
      await outbox(connection, 'operation', operation.id, 'operation.changed', operationSummary(input.result))
      // `symbol` is intentionally consumed above: assertCurrentState returns
      // the exact target/open symbol to make the revalidation visible in code.
      void symbol
      return input.result
    })
  }
}

interface AccountIdentityRow extends RowDataPacket { account_id: string; currency: string }
interface TradingContextRow extends RowDataPacket { mode: 'full' | 'observer' | 'blocked'; read_only: number }
interface RuntimeSnapshotRow extends RowDataPacket {
  revision: number; trade_permission: number; timezone_offset_minutes: number | null
  clock_status: AccountRiskSummary['clockStatus']; balance: string; equity: string; margin_amount: string; free_margin: string
}
interface PayloadRevisionRow extends RowDataPacket { ticket: string; payload_json: string | object; revision: number }
interface QuoteRow extends RowDataPacket { symbol: string; bid: string; ask: string; observed_at_utc: Date; revision: number }
interface InstrumentRow extends RowDataPacket { symbol: string; payload_json: string | object; observed_at_utc: Date; revision: number }
interface SummaryRow extends RowDataPacket { payload_json: string | object; observed_at_utc: Date; revision: number }
interface RiskStateRevisionRow extends RowDataPacket { revision: number }
interface CapacityRow extends RowDataPacket {
  open_positions: number; pending_orders: number; total_volume: string; daily_open_count: number
}
interface ReservationTotalRow extends RowDataPacket {
  reserved_volume: string | null; reserved_open_positions: string | null
  reserved_pending_orders: string | null; reserved_daily_opens: string | null
}
interface ProjectionRevisionRow extends RowDataPacket { resource_kind: string; resource_id: string; revision: number }
interface PolicyRow extends RowDataPacket {
  scope: 'platform' | 'account'; set_revision: number; version_id: string; policy_json: string | object; updated_at_utc: Date
}
interface ControlRow extends RowDataPacket { kill_switch: number; revision: number }
interface ManualReleaseRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; status: ManualRiskRelease['status']
  platform_policy_version_id: string; account_policy_version_id: string | null; policy_set_revision: number
  released_rules_json: string | object; baseline_json: string | object; risk_state_revision: number; breach_fingerprint: string
  reason: string; expires_at_utc: Date; created_at_utc: Date; invalidated_at_utc: Date | null; invalidation_reason: string | null; revision: number
}
interface UserCommandWithOperationRow extends RowDataPacket {
  id: string; operation_id: string; user_id: number; trading_account_id: string; command_type: NormalizedUserExecutionCommand['commandType']
  source_type: NormalizedUserExecutionCommand['sourceType']; source_id: string; idempotency_key: string; request_sha256: string
  request_json: string | object; action_json: string | object; expected_state_json: string | object; risk_evaluation_json: string | object
  risk_status: 'approved' | 'rejected'; reject_code: string | null; platform_policy_version_id: string; account_policy_version_id: string | null
  policy_set_revision: number; policy_sha256: string; account_revision: number; positions_revision: number; pending_orders_revision: number
  quote_revision: number; contract_revision: number; risk_revision: number; manual_release_id: string | null; created_at_utc: Date; updated_at_utc: Date; revision: number
  operation_user_id: number; operation_account_id: string; operation_kind: UserExecutionOperation['kind']; operation_status: UserExecutionOperation['status']
  operation_source_type: UserExecutionOperation['sourceType']; operation_source_id: string; operation_idempotency_scope: UserExecutionOperation['idempotencyScope']
  operation_idempotency_key: string; operation_request_sha256: string; resource_type: UserExecutionOperation['resourceType']; resource_id: string | null
  operation_parent_operation_id: string | null; operation_distribution_id: string | null; result_summary_json: string | object | null
  operation_error_code: string | null; accepted_at_utc: Date; operation_updated_at_utc: Date; completed_at_utc: Date | null; operation_revision: number
}
interface StoredIntentRow extends RowDataPacket {
  id: string; operation_id: string; risk_decision_id: string | null; trade_decision_id: string | null; user_command_id: string | null
  user_id: number; trading_account_id: string; action_id: string; action_kind: UserExecutionIntent['actionKind']; source_type: UserExecutionIntent['sourceType']; source_id: string
  idempotency_key: string; request_sha256: string; expected_state_sha256: string; status: UserExecutionIntent['status']; expires_at_utc: Date
  error_code: string | null; created_at_utc: Date; updated_at_utc: Date; completed_at_utc: Date | null; revision: number
  action_json: string | object; expected_state_json: string | object; reservation_id: string | null
}
interface StoredReservationRow extends RowDataPacket {
  id: string; execution_intent_id: string; user_id: number; trading_account_id: string; symbol: string; account_currency: string
  reserved_volume: string; reserved_risk_amount: string; reserved_risk_percent: string; reserved_open_positions: number; reserved_pending_orders: number; reserved_daily_opens: number
  status: UserExecutionRiskReservation['status']; expires_at_utc: Date; released_at_utc: Date | null; release_reason: string | null; created_at_utc: Date; updated_at_utc: Date; revision: number
}
interface CurrentRevisionRow extends RowDataPacket {
  account_projection_revision: number | null; account_snapshot_revision: number | null; positions_revision: number | null; pending_orders_revision: number | null
  quote_revision: number | null; quote_projection_revision: number | null; contract_revision: number | null; risk_summary_revision: number | null; risk_state_revision: number | null
}

const userCommandSelect = `
  SELECT c.id,c.operation_id,c.user_id,CAST(c.trading_account_id AS CHAR) trading_account_id,c.command_type,c.source_type,c.source_id,
    c.idempotency_key,c.request_sha256,c.request_json,c.action_json,c.expected_state_json,c.risk_evaluation_json,c.risk_status,c.reject_code,
    CAST(c.platform_policy_version_id AS CHAR) platform_policy_version_id,CAST(c.account_policy_version_id AS CHAR) account_policy_version_id,
    c.policy_set_revision,c.policy_sha256,c.account_revision,c.positions_revision,c.pending_orders_revision,c.quote_revision,c.contract_revision,c.risk_revision,
    c.manual_release_id,c.created_at_utc,c.updated_at_utc,c.revision,
    op.user_id operation_user_id,CAST(op.trading_account_id AS CHAR) operation_account_id,op.kind operation_kind,op.status operation_status,
    op.source_type operation_source_type,op.source_id operation_source_id,op.idempotency_scope operation_idempotency_scope,op.idempotency_key operation_idempotency_key,
    op.request_sha256 operation_request_sha256,op.resource_type,op.resource_id,op.parent_operation_id operation_parent_operation_id,
    op.distribution_id operation_distribution_id,op.result_summary_json,op.error_code operation_error_code,op.accepted_at_utc,
    op.updated_at_utc operation_updated_at_utc,op.completed_at_utc,op.revision operation_revision
  FROM user_execution_commands c
  INNER JOIN operations op ON op.id=c.operation_id`

async function lockAccount(connection: PoolConnection, userId: number, accountId: string) {
  const [rows] = await connection.execute<AccountIdentityRow[]>(`
    SELECT CAST(id AS CHAR) account_id,currency
    FROM trading_accounts
    WHERE id=? AND deleted_at_utc IS NULL
    LIMIT 1 FOR UPDATE`, [accountId])
  if (!rows[0]) throw new UserExecutionCommandError('user_command_account_forbidden', 403)
  return rows[0]
}

async function lockOwner(connection: PoolConnection, userId: number, accountId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`
    SELECT 1
    FROM trading_account_ownerships
    WHERE user_id=? AND trading_account_id=? AND role='owner' AND revoked_at_utc IS NULL
    LIMIT 1 FOR SHARE`, [userId, accountId])
  if (!rows[0]) throw new UserExecutionCommandError('user_command_account_forbidden', 403)
}

async function assertWritableContext(connection: PoolConnection, userId: number) {
  const [rows] = await connection.execute<TradingContextRow[]>(`
    SELECT mode,read_only
    FROM trading_contexts
    WHERE user_id=?
    LIMIT 1 FOR SHARE`, [userId])
  const context = rows[0]
  if (context && (context.mode !== 'full' || Boolean(context.read_only))) {
    throw new UserExecutionCommandError('user_command_observer_forbidden', 403)
  }
}

async function assertTradePermission(connection: PoolConnection, accountId: string, expectedRevision: number) {
  const [rows] = await connection.execute<(RowDataPacket & { trade_permission: number; revision: number })[]>(`
    SELECT trade_permission,revision
    FROM account_runtime_snapshots
    WHERE trading_account_id=?
    LIMIT 1 FOR SHARE`, [accountId])
  const runtime = rows[0]
  if (!runtime || Number(runtime.revision) !== expectedRevision) {
    throw new UserExecutionCommandError('user_command_expected_state_stale', 409, { resource: 'account' })
  }
  if (!Boolean(runtime.trade_permission)) throw new UserExecutionCommandError('user_command_trade_permission_required', 409)
}

async function findIdempotencyOnConnection(connection: PoolConnection, userId: number, accountId: string, key: string) {
  const [rows] = await connection.execute<UserCommandWithOperationRow[]>(`${userCommandSelect}
    WHERE c.user_id=? AND c.trading_account_id=? AND c.idempotency_key=?
    LIMIT 1 FOR UPDATE`, [userId, accountId, key])
  return rows[0] ?? null
}

async function assertCurrentState(
  connection: PoolConnection,
  command: NormalizedUserExecutionCommand,
  action: PersistUserExecutionCommandInput['action'],
  accountCurrency: string,
  expected: UserExecutionExpectedRevisions,
) {
  const directSymbol = typeof action.parameters.symbol === 'string' ? normalizeSymbol(action.parameters.symbol) : null
  let target: TargetState | null = null
  if (typeof action.parameters.ticket === 'string') target = await loadTargetForUpdate(connection, command.commandType, command.accountId, action.parameters.ticket)
  const symbol = directSymbol ?? normalizeSymbol(target?.payload.symbol)
  if (!symbol) throw new UserExecutionCommandError('user_command_symbol_context_mismatch', 409)
  const current = await currentRevisionsOnConnection(connection, command.accountId, symbol)
  compareRevisions(expected, current)
  if (target) {
    const actual = Number(target.revision)
    const payloadRevision = Number(target.payload.revision)
    if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(payloadRevision) || actual !== payloadRevision || actual !== expected.resourceRevision) {
      throw new UserExecutionCommandError('user_command_target_stale', 409, { ticket: target.ticket })
    }
  } else if (expected.resourceRevision !== null) {
    throw new UserExecutionCommandError('user_command_target_not_found', 409)
  }
  // Account currency is part of the persisted reservation contract.  An empty
  // value is a schema/data-integrity failure, never a reason to continue.
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(String(accountCurrency ?? '').trim().toUpperCase())) {
    throw new UserExecutionCommandError('user_command_account_currency_invalid', 422)
  }
  return symbol
}

interface TargetState { ticket: string; revision: number; payload: Record<string, unknown> }

async function loadTargetForUpdate(connection: PoolConnection, commandType: NormalizedUserExecutionCommand['commandType'], accountId: string, ticket: string): Promise<TargetState | null> {
  const table = commandType === 'modify_position' || commandType === 'close_position' ? 'open_position_snapshots' : 'pending_order_snapshots'
  const [rows] = await connection.execute<PayloadRevisionRow[]>(`SELECT ticket,payload_json,revision FROM ${table} WHERE trading_account_id=? AND ticket=? LIMIT 1 FOR UPDATE`, [accountId, ticket])
  const row = rows[0]
  if (!row) throw new UserExecutionCommandError('user_command_target_not_found', 409, { ticket })
  return { ticket: row.ticket, revision: Number(row.revision), payload: parse<Record<string, unknown>>(row.payload_json, 'user_command_target_payload_invalid') }
}

async function currentRevisionsOnConnection(connection: Pool | PoolConnection, accountId: string, symbol: string) {
  const [rows] = await connection.execute<CurrentRevisionRow[]>(`
    SELECT
      (SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind='account.metrics' AND resource_id='current' LIMIT 1) account_projection_revision,
      (SELECT revision FROM account_runtime_snapshots WHERE trading_account_id=? LIMIT 1) account_snapshot_revision,
      (SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind='positions' AND resource_id='open' LIMIT 1) positions_revision,
      (SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind='pending_orders' AND resource_id='open' LIMIT 1) pending_orders_revision,
      (SELECT revision FROM market_quotes WHERE trading_account_id=? AND symbol=? LIMIT 1) quote_revision,
      (SELECT revision FROM trading_projection_revisions WHERE trading_account_id=? AND resource_kind='market.quote' AND resource_id=? LIMIT 1) quote_projection_revision,
      (SELECT revision FROM market_instrument_snapshots WHERE trading_account_id=? AND symbol=? LIMIT 1) contract_revision,
      (SELECT revision FROM account_risk_summaries WHERE trading_account_id=? LIMIT 1) risk_summary_revision,
      (SELECT revision FROM account_risk_states WHERE trading_account_id=? LIMIT 1) risk_state_revision`, [
    accountId, accountId, accountId, accountId, accountId, symbol, accountId, symbol, accountId, symbol, accountId, accountId,
  ])
  const row = rows[0]
  if (!row) throw new UserExecutionCommandError('user_command_revision_unavailable', 409)
  const accountProjection = nullableRevision(row.account_projection_revision)
  const accountSnapshot = nullableRevision(row.account_snapshot_revision)
  if (accountProjection !== null && accountSnapshot !== null && accountProjection !== accountSnapshot) throw new UserExecutionCommandError('user_command_revision_unavailable', 409)
  const riskSummary = nullableRevision(row.risk_summary_revision)
  const riskState = nullableRevision(row.risk_state_revision)
  if (riskSummary !== null && riskState !== null && riskSummary !== riskState) throw new UserExecutionCommandError('user_command_revision_unavailable', 409)
  const quote = nullableRevision(row.quote_revision)
  const quoteProjection = nullableRevision(row.quote_projection_revision)
  if (quote !== null && quoteProjection !== null && quote !== quoteProjection) throw new UserExecutionCommandError('user_command_revision_unavailable', 409)
  return {
    account: accountSnapshot ?? accountProjection ?? 0,
    positions: nullableRevision(row.positions_revision) ?? 0,
    pendingOrders: nullableRevision(row.pending_orders_revision) ?? 0,
    quote: quote ?? 0,
    contract: nullableRevision(row.contract_revision) ?? 0,
    risk: riskSummary ?? riskState ?? 0,
  } satisfies Pick<UserExecutionCurrentRevisions, 'account' | 'positions' | 'pendingOrders' | 'quote' | 'contract' | 'risk'>
}

function compareRevisions(expected: UserExecutionExpectedRevisions, current: Pick<UserExecutionCurrentRevisions, 'account' | 'positions' | 'pendingOrders' | 'quote' | 'contract' | 'risk'>) {
  const pairs: Array<[number, number, string]> = [
    [expected.accountRevision, current.account, 'account'], [expected.positionsRevision, current.positions, 'positions'],
    [expected.pendingOrdersRevision, current.pendingOrders, 'pending_orders'], [expected.quoteRevision, current.quote, 'quote'],
    [expected.contractRevision, current.contract, 'contract'], [expected.riskRevision, current.risk, 'risk'],
  ]
  for (const [wanted, actual, resource] of pairs) if (wanted !== actual) throw new UserExecutionCommandError('user_command_expected_state_stale', 409, { resource })
}

async function loadQuote(pool: Pool, accountId: string, symbol: string | null): Promise<RiskQuoteSnapshot> {
  const [rows] = symbol
    ? await pool.execute<QuoteRow[]>('SELECT symbol,bid,ask,observed_at_utc,revision FROM market_quotes WHERE trading_account_id=? AND symbol=? LIMIT 1', [accountId, symbol])
    : await pool.execute<QuoteRow[]>('SELECT symbol,bid,ask,observed_at_utc,revision FROM market_quotes WHERE trading_account_id=? ORDER BY observed_at_utc DESC,symbol LIMIT 1', [accountId])
  const row = rows[0]
  if (!row) return { symbol: symbol ?? '', bid: '0', ask: '0', observedAt: new Date(0).toISOString(), revision: 0 }
  return { symbol: row.symbol, bid: String(row.bid), ask: String(row.ask), observedAt: iso(row.observed_at_utc), revision: Number(row.revision) }
}

async function loadInstrument(pool: Pool, accountId: string, symbol: string | null): Promise<RiskInstrumentSnapshot> {
  const [rows] = symbol
    ? await pool.execute<InstrumentRow[]>('SELECT symbol,payload_json,observed_at_utc,revision FROM market_instrument_snapshots WHERE trading_account_id=? AND symbol=? LIMIT 1', [accountId, symbol])
    : await pool.execute<InstrumentRow[]>('SELECT symbol,payload_json,observed_at_utc,revision FROM market_instrument_snapshots WHERE trading_account_id=? ORDER BY observed_at_utc DESC,symbol LIMIT 1', [accountId])
  const row = rows[0]
  if (!row) return { symbol: symbol ?? '', point: '', tickSize: '', tickValue: '', volumeMin: '', volumeMax: '', volumeStep: '', tradeEnabled: false, revision: 0 }
  const value = parse<Record<string, unknown>>(row.payload_json, 'user_command_instrument_payload_invalid')
  const stringValue = (camel: string, snake: string) => String(value[camel] ?? value[snake] ?? '')
  const tradeMode = String(value.tradeMode ?? value.trade_mode ?? '').toLowerCase()
  return {
    symbol: row.symbol, point: stringValue('point', 'point'), tickSize: stringValue('tickSize', 'tick_size'), tickValue: stringValue('tickValue', 'tick_value'),
    volumeMin: stringValue('volumeMin', 'volume_min'), volumeMax: stringValue('volumeMax', 'volume_max'), volumeStep: stringValue('volumeStep', 'volume_step'),
    tradeEnabled: typeof value.tradeEnabled === 'boolean' ? value.tradeEnabled : ['full', 'enabled', 'long_only', 'short_only'].includes(tradeMode),
    revision: Number(row.revision),
  }
}

async function loadRiskSummary(pool: Pool, accountId: string, userId: number, runtime: RuntimeSnapshotRow | undefined): Promise<AccountRiskSummary> {
  const [rows] = await pool.execute<SummaryRow[]>('SELECT payload_json,observed_at_utc,revision FROM account_risk_summaries WHERE trading_account_id=? LIMIT 1', [accountId])
  const row = rows[0]
  if (row) return mapRiskSummary(parse<Record<string, unknown>>(row.payload_json, 'user_command_risk_summary_invalid'), accountId, userId, Number(row.revision), row.observed_at_utc)
  const observedAt = new Date(0).toISOString()
  return {
    accountId, userId, businessDate: null,
    equity: String(runtime?.equity ?? '0'), freeMargin: String(runtime?.free_margin ?? '0'), marginLevelPercent: null,
    dailyLossPercent: 0, drawdownPercent: 0, openPositions: 0, pendingOrders: 0, totalVolume: '0', dailyOpenCount: 0, consecutiveLosses: 0,
    terminalTimezoneOffsetMinutes: runtime?.timezone_offset_minutes ?? null, clockStatus: runtime?.clock_status ?? 'unavailable',
    lastSuccessfulOpenAt: null, cooldownUntil: null, dataComplete: false, incompleteReasons: ['risk_summary_missing'], observedAt, revision: 0,
  }
}

function mapRiskSummary(value: Record<string, unknown>, accountId: string, userId: number, revision: number, observedAt: Date): AccountRiskSummary {
  const text = (camel: string, snake: string, fallback = '') => String(value[camel] ?? value[snake] ?? fallback)
  const nullableText = (camel: string, snake: string) => {
    const candidate = value[camel] ?? value[snake]
    return candidate === null || candidate === undefined || candidate === '' ? null : String(candidate)
  }
  const numeric = (camel: string, snake: string, fallback = 0) => {
    const number = Number(value[camel] ?? value[snake] ?? fallback)
    return Number.isFinite(number) ? number : fallback
  }
  const integer = (camel: string, snake: string) => Math.max(0, Math.trunc(numeric(camel, snake)))
  const reasons = value.incompleteReasons ?? value.incomplete_reasons
  return {
    accountId, userId, businessDate: nullableText('businessDate', 'business_date'), equity: text('equity', 'equity', '0'), freeMargin: text('freeMargin', 'free_margin', '0'),
    marginLevelPercent: value.marginLevelPercent === null || value.margin_level_percent === null ? null : numeric('marginLevelPercent', 'margin_level_percent', 0),
    dailyLossPercent: Math.max(0, numeric('dailyLossPercent', 'daily_loss_percent')), drawdownPercent: Math.max(0, numeric('drawdownPercent', 'drawdown_percent')),
    openPositions: integer('openPositions', 'open_positions'), pendingOrders: integer('pendingOrders', 'pending_orders'), totalVolume: text('totalVolume', 'total_volume', '0'),
    dailyOpenCount: integer('dailyOpenCount', 'daily_open_count'), consecutiveLosses: integer('consecutiveLosses', 'consecutive_losses'),
    terminalTimezoneOffsetMinutes: value.terminalTimezoneOffsetMinutes === null || value.terminal_timezone_offset_minutes === null ? null : numeric('terminalTimezoneOffsetMinutes', 'terminal_timezone_offset_minutes', 0),
    clockStatus: normalizeClockStatus(value.clockStatus ?? value.clock_status), lastSuccessfulOpenAt: nullableText('lastSuccessfulOpenAt', 'last_successful_open_at'), cooldownUntil: nullableText('cooldownUntil', 'cooldown_until'),
    dataComplete: Boolean(value.dataComplete ?? value.data_complete), incompleteReasons: Array.isArray(reasons) ? reasons.map(String) : [], observedAt: text('observedAt', 'observed_at', iso(observedAt)), revision,
  }
}

async function loadManualRelease(pool: Pool, userId: number, accountId: string): Promise<ManualRiskRelease | null> {
  const [rows] = await pool.execute<ManualReleaseRow[]>(`${manualReleaseSelect}
    WHERE r.user_id=? AND r.trading_account_id=? AND r.status='active'
    ORDER BY r.created_at_utc DESC,r.id DESC LIMIT 1`, [userId, accountId])
  return rows[0] ? mapManualRelease(rows[0]) : null
}

async function effectivePolicy(executor: Pool | PoolConnection, userId: number, accountId: string): Promise<EffectiveRiskPolicy> {
  const [platformRows] = await executor.execute<PolicyRow[]>(policySelect("p.scope='platform'"), [])
  const [accountRows] = await executor.execute<PolicyRow[]>(policySelect("p.scope='account' AND p.owner_user_id=? AND p.trading_account_id=?"), [userId, accountId])
  const [controlRows] = await executor.execute<ControlRow[]>('SELECT kill_switch,revision FROM global_risk_controls WHERE id=1 LIMIT 1', [])
  const platform = platformRows[0]
  if (!platform) throw new UserExecutionCommandError('user_command_policy_missing', 409)
  const account = accountRows[0]
  return resolveRiskPolicy({
    accountId, userId, platformPolicyVersionId: platform.version_id, accountPolicyVersionId: account?.version_id ?? null,
    policySetRevision: Number(account?.set_revision ?? 0), platform: { values: platformValues(platform.policy_json), globalKillSwitch: Boolean(controlRows[0]?.kill_switch), revision: Number(controlRows[0]?.revision ?? 0) },
    account: account ? accountPatch(account.policy_json) : null, updatedAt: iso(account?.updated_at_utc ?? platform.updated_at_utc),
  })
}

async function currentRevisions(pool: Pool, accountId: string, symbol: string | null, accountRevision: number | null, riskRevision: number) {
  const current = await currentRevisionsOnConnection(pool, accountId, symbol ?? '')
  return { ...current, account: accountRevision ?? current.account, risk: riskRevision || current.risk, analysis: 0, subscription: 0 }
}

function policySelect(where: string) {
  return `SELECT p.scope,p.revision set_revision,CAST(v.id AS CHAR) version_id,v.policy_json,p.updated_at_utc FROM risk_policy_sets_v4 p INNER JOIN risk_policy_versions_v4 v ON v.id=p.active_version_id AND v.policy_set_id=p.id WHERE p.status='active' AND ${where} LIMIT 1`
}

function platformValues(value: string | object) {
  const parsed = parse<Partial<typeof DEFAULT_RISK_POLICY> & { values?: Partial<typeof DEFAULT_RISK_POLICY> }>(value, 'user_command_policy_invalid')
  const values = parsed.values ?? parsed
  return { ...DEFAULT_RISK_POLICY, ...values, allowedSymbols: [...(values.allowedSymbols ?? DEFAULT_RISK_POLICY.allowedSymbols)], requireStopLoss: true as const, failClosedOnIncompleteData: true as const }
}

function accountPatch(value: string | object) {
  const parsed = parse<Record<string, unknown> & { values?: Record<string, unknown> }>(value, 'user_command_policy_invalid')
  return (parsed.values ?? parsed) as AccountRiskPolicyPatch
}

const manualReleaseSelect = `SELECT r.id,r.user_id,CAST(r.trading_account_id AS CHAR) trading_account_id,r.status,
  CAST(r.platform_policy_version_id AS CHAR) platform_policy_version_id,CAST(r.account_policy_version_id AS CHAR) account_policy_version_id,
  r.policy_set_revision,r.released_rules_json,r.baseline_json,r.risk_state_revision,r.breach_fingerprint,r.reason,r.expires_at_utc,r.created_at_utc,
  r.invalidated_at_utc,r.invalidation_reason,r.revision FROM risk_manual_releases r`

function mapManualRelease(row: ManualReleaseRow): ManualRiskRelease {
  return {
    id: row.id, userId: Number(row.user_id), accountId: String(row.trading_account_id), platformPolicyVersionId: row.platform_policy_version_id,
    accountPolicyVersionId: row.account_policy_version_id, policySetRevision: Number(row.policy_set_revision), status: row.status,
    releasedRules: parse<ManualReleaseRuleCode[]>(row.released_rules_json, 'user_command_manual_release_invalid'), baseline: parse(row.baseline_json, 'user_command_manual_release_invalid'),
    riskStateRevision: Number(row.risk_state_revision), breachFingerprint: row.breach_fingerprint, reason: row.reason,
    expiresAt: iso(row.expires_at_utc), createdAt: iso(row.created_at_utc), invalidatedAt: row.invalidated_at_utc ? iso(row.invalidated_at_utc) : null,
    invalidationReason: row.invalidation_reason, revision: Number(row.revision),
  }
}

function mapProjectionItem(row: PayloadRevisionRow): JsonObject {
  const value = parse<JsonObject>(row.payload_json, 'user_command_projection_payload_invalid')
  const payloadRevision = Number(value.revision)
  return { ...value, ticket: String(value.ticket ?? row.ticket), revision: Number.isSafeInteger(payloadRevision) && payloadRevision === Number(row.revision) ? payloadRevision : -1 }
}

async function loadStoredResult(executor: Pool | PoolConnection, row: UserCommandWithOperationRow, operation: UserExecutionOperation): Promise<UserExecutionCommandResult> {
  const command = parse<NormalizedUserExecutionCommand>(row.request_json, 'user_command_stored_request_invalid')
  const riskEvaluation = parse<RiskEvaluationResult>(row.risk_evaluation_json, 'user_command_stored_risk_invalid')
  if (row.risk_status === 'rejected') {
    const result: RejectedUserExecutionCommandResult = { kind: 'rejected', command, sourceHash: row.request_sha256, operation, intent: null, reservations: [], riskEvaluation }
    return result
  }
  const [intentRows] = await executor.execute<StoredIntentRow[]>(`
    SELECT ei.*,p.action_json,p.expected_state_json,rr.id reservation_id
    FROM execution_intents ei
    INNER JOIN execution_intent_payloads p ON p.execution_intent_id=ei.id
    LEFT JOIN risk_reservations_v4 rr ON rr.execution_intent_id=ei.id
    WHERE ei.operation_id=? AND ei.user_command_id=?
    ORDER BY ei.id`, [operation.id, command.commandId])
  if (!intentRows[0]) throw new UserExecutionCommandError('user_command_persisted_intent_missing', 503)
  const intents = intentRows.map(rowItem => mapStoredIntent(rowItem, operation))
  operation.intentIds = intents.map(item => item.id)
  const [reservationRows] = await executor.execute<StoredReservationRow[]>(`SELECT * FROM risk_reservations_v4 WHERE execution_intent_id=? ORDER BY id`, [intents[0]!.id])
  const result: PreparedUserExecutionBundle = { kind: 'prepared', command, sourceHash: row.request_sha256, operation, intent: intents[0]!, reservations: reservationRows.map(mapStoredReservation), riskEvaluation }
  return result
}

function mapOperation(row: UserCommandWithOperationRow): UserExecutionOperation {
  return {
    id: row.operation_id, userId: Number(row.operation_user_id ?? row.user_id), accountId: String(row.operation_account_id ?? row.trading_account_id),
    kind: row.operation_kind, status: row.operation_status, sourceType: row.operation_source_type, sourceId: row.operation_source_id,
    parentOperationId: row.operation_parent_operation_id, distributionId: row.operation_distribution_id, idempotencyScope: row.operation_idempotency_scope,
    clientIdempotencyKey: row.idempotency_key, idempotencyKey: row.operation_idempotency_key, requestHash: row.operation_request_sha256,
    resourceType: row.resource_type, resourceId: row.resource_id, errorCode: row.operation_error_code, acceptedAt: iso(row.accepted_at_utc),
    updatedAt: iso(row.operation_updated_at_utc), completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null, revision: Number(row.operation_revision), intentIds: [],
  }
}

function mapStoredIntent(row: StoredIntentRow, operation: UserExecutionOperation): UserExecutionIntent {
  return {
    id: row.id, operationId: row.operation_id, riskDecisionId: null, tradeDecisionId: null, userId: Number(row.user_id), accountId: String(row.trading_account_id),
    actionId: row.action_id, actionKind: row.action_kind, action: parse(row.action_json, 'user_command_stored_action_invalid'), sourceType: row.source_type,
    sourceId: row.source_id, parentOperationId: operation.parentOperationId, distributionId: operation.distributionId, idempotencyKey: row.idempotency_key, requestHash: row.request_sha256,
    expectedStateHash: row.expected_state_sha256, status: row.status, expiresAt: iso(row.expires_at_utc), createdAt: iso(row.created_at_utc),
    updatedAt: iso(row.updated_at_utc), completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null, errorCode: row.error_code, revision: Number(row.revision),
    riskReservationId: row.reservation_id,
  }
}

function mapStoredReservation(row: StoredReservationRow): UserExecutionRiskReservation {
  return {
    id: row.id, executionIntentId: row.execution_intent_id, userId: Number(row.user_id), accountId: String(row.trading_account_id), symbol: row.symbol,
    accountCurrency: row.account_currency, reservedVolume: Number(row.reserved_volume), reservedRiskAmount: Number(row.reserved_risk_amount), reservedRiskPercent: Number(row.reserved_risk_percent),
    reservedOpenPositions: Number(row.reserved_open_positions), reservedPendingOrders: Number(row.reserved_pending_orders), reservedDailyOpens: Number(row.reserved_daily_opens),
    status: row.status, expiresAt: iso(row.expires_at_utc), releasedAt: row.released_at_utc ? iso(row.released_at_utc) : null, releaseReason: row.release_reason,
    createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc), revision: Number(row.revision),
  }
}

async function insertPrepared(connection: PoolConnection, result: PreparedUserExecutionBundle, riskEvaluation: RiskEvaluationResult) {
  const intent = result.intent
  await connection.execute(`
    INSERT INTO execution_intents
      (id,operation_id,risk_decision_id,trade_decision_id,user_command_id,risk_decision_revision,account_risk_revision,user_id,trading_account_id,
       action_id,action_kind,source_type,source_id,idempotency_key,request_sha256,expected_state_sha256,status,expires_at_utc,error_code,
       created_at_utc,updated_at_utc,completed_at_utc,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    intent.id, intent.operationId, null, null, result.command.commandId, null, result.command.expected.riskRevision, intent.userId, intent.accountId,
    intent.actionId, intent.actionKind, intent.sourceType, intent.sourceId, intent.idempotencyKey, intent.requestHash, intent.expectedStateHash,
    intent.status, intent.expiresAt, intent.errorCode, intent.createdAt, intent.updatedAt, intent.completedAt, intent.revision,
  ])
  const actionJson = JSON.stringify(intent.action)
  const expectedJson = JSON.stringify(intent.action.expectedState)
  await connection.execute(`INSERT INTO execution_intent_payloads (execution_intent_id,action_json,action_sha256,expected_state_json,expected_state_sha256,payload_bytes) VALUES (?,?,?,?,?,?)`, [
    intent.id, actionJson, sha256Canonical(intent.action), expectedJson, intent.expectedStateHash, Buffer.byteLength(actionJson) + Buffer.byteLength(expectedJson),
  ])
  await connection.execute(`INSERT INTO execution_intent_events (execution_intent_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,'execution.intent.prepared',NULL,'prepared',NULL,NULL,1,?,?)`, [intent.id, JSON.stringify({ command_id: result.command.commandId }), intent.createdAt])
  await outbox(connection, 'execution_intent', intent.id, 'execution.intent.prepared', { intent_id: intent.id, operation_id: intent.operationId, account_id: intent.accountId })
  for (const reservation of result.reservations) {
    await connection.execute(`
      INSERT INTO risk_reservations_v4
        (id,execution_intent_id,user_id,trading_account_id,symbol,account_currency,reserved_volume,reserved_risk_amount,reserved_risk_percent,
         reserved_open_positions,reserved_pending_orders,reserved_daily_opens,status,expires_at_utc,released_at_utc,release_reason,created_at_utc,updated_at_utc,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      reservation.id, reservation.executionIntentId, reservation.userId, reservation.accountId, reservation.symbol, reservation.accountCurrency,
      reservation.reservedVolume, reservation.reservedRiskAmount, reservation.reservedRiskPercent, reservation.reservedOpenPositions,
      reservation.reservedPendingOrders, reservation.reservedDailyOpens, reservation.status, reservation.expiresAt, reservation.releasedAt,
      reservation.releaseReason, reservation.createdAt, reservation.updatedAt, reservation.revision,
    ])
    await connection.execute(`INSERT INTO risk_reservation_events_v4 (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc) VALUES (?,'risk.reservation.activated',NULL,'active',NULL,NULL,1,?)`, [reservation.id, reservation.createdAt])
  }
  // Keep this argument explicit: the caller has already persisted the complete
  // risk evaluation on the user-command row, and no FK is manufactured here.
  void riskEvaluation
}

async function assertReservationCapacity(
  connection: PoolConnection,
  accountId: string,
  policy: EffectiveRiskPolicy,
  next: UserExecutionRiskReservation[],
  evaluation: RiskEvaluationResult,
) {
  if (next.length === 0) return
  const [capacityRows] = await connection.execute<CapacityRow[]>(`
    SELECT open_positions,pending_orders,total_volume,daily_open_count
    FROM account_risk_states
    WHERE trading_account_id=?
    LIMIT 1 FOR UPDATE`, [accountId])
  const capacity = capacityRows[0]
  if (!capacity) throw new UserExecutionCommandError('user_command_risk_state_missing', 409)
  const [activeRows] = await connection.execute<ReservationTotalRow[]>(`
    SELECT COALESCE(SUM(reserved_volume),0) reserved_volume,
      COALESCE(SUM(reserved_open_positions),0) reserved_open_positions,
      COALESCE(SUM(reserved_pending_orders),0) reserved_pending_orders,
      COALESCE(SUM(reserved_daily_opens),0) reserved_daily_opens
    FROM risk_reservations_v4
    WHERE trading_account_id=? AND status IN ('active','committed')
    FOR UPDATE`, [accountId])
  const active = activeRows[0] ?? { reserved_volume: '0', reserved_open_positions: '0', reserved_pending_orders: '0', reserved_daily_opens: '0' }
  const added = next.reduce((sum, item) => ({
    volume: sum.volume + item.reservedVolume,
    open: sum.open + item.reservedOpenPositions,
    pending: sum.pending + item.reservedPendingOrders,
    daily: sum.daily + item.reservedDailyOpens,
  }), { volume: 0, open: 0, pending: 0, daily: 0 })
  const releasedDailyLimit = evaluation.rules.some(rule => rule.code === 'RISK_MANUAL_RELEASE_APPLIED'
    && rule.details.released_rule === 'RISK_DAILY_OPEN_LIMIT')
  const dailyLimit = releasedDailyLimit ? policy.values.manualReleaseMaxDailyOpenCount : policy.values.maxDailyOpenCount
  const exceeds = Number(capacity.total_volume) + Number(active.reserved_volume ?? 0) + added.volume > policy.values.maxTotalVolume + 1e-9
    || Number(capacity.open_positions) + Number(active.reserved_open_positions ?? 0) + added.open > policy.values.maxOpenPositions
    || Number(capacity.pending_orders) + Number(active.reserved_pending_orders ?? 0) + added.pending > policy.values.maxPendingOrders
    || Number(capacity.daily_open_count) + Number(active.reserved_daily_opens ?? 0) + added.daily > dailyLimit
  if (exceeds) throw new UserExecutionCommandError('user_command_capacity_exceeded', 409)
}

async function insertOperationEvent(connection: PoolConnection, operation: UserExecutionOperation, eventType: string) {
  await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,?,NULL,?,?,NULL,?,?,?)`, [
    operation.id, eventType, operation.status, operation.errorCode, operation.revision, JSON.stringify(operationSummary({ operation })), operation.updatedAt,
  ])
}

function operationSummary(result: UserExecutionCommandResult | { operation: UserExecutionOperation }) {
  return {
    operation_id: result.operation.id, kind: result.operation.kind, status: result.operation.status,
    source_type: result.operation.sourceType, source_id: result.operation.sourceId, account_id: result.operation.accountId,
    error_code: result.operation.errorCode, updated_at: result.operation.updatedAt, revision: String(result.operation.revision),
  }
}

function assertOperationIdentity(input: PersistUserExecutionCommandInput) {
  const operation = input.result.operation
  const expectedKey = sha256Canonical({ userId: input.command.userId, accountId: input.command.accountId, idempotencyKey: input.command.idempotencyKey })
  if (operation.kind !== 'user_execution_command' || operation.idempotencyScope !== 'user_command' || operation.idempotencyKey !== expectedKey
    || operation.userId !== input.command.userId || operation.accountId !== input.command.accountId || operation.requestHash !== input.command.requestHash) {
    throw new UserExecutionCommandError('user_command_operation_identity_invalid', 500)
  }
}

function policyHashFromEvaluation(value: RiskEvaluationResult) {
  const hash = String(value.policyHash ?? '').trim()
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new UserExecutionCommandError('user_command_risk_data_invalid', 422)
  return hash
}

function numericId(value: string) {
  if (!/^\d+$/.test(String(value))) throw new UserExecutionCommandError('user_command_policy_id_invalid', 409)
  return Number(value)
}

function nullableNumericId(value: string | null) {
  return value === null ? null : numericId(value)
}

function mapRiskSummaryRevision(value: unknown) { return Number.isSafeInteger(Number(value)) ? Number(value) : 0 }
function nullableRevision(value: unknown) { const number = mapRiskSummaryRevision(value); return number > 0 ? number : value === 0 ? 0 : null }
function normalizeSymbol(value: unknown) { const symbol = String(value ?? '').trim().toUpperCase(); return /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(symbol) ? symbol : null }
function normalizeClockStatus(value: unknown): AccountRiskSummary['clockStatus'] { return value === 'calibrated' || value === 'observer_bootstrap' || value === 'stale' || value === 'unavailable' ? value : 'unavailable' }
function parse<T>(value: string | object, code: string): T { try { return (typeof value === 'string' ? JSON.parse(value) : value) as T } catch { throw new UserExecutionCommandError(code, 503) } }
function iso(value: Date | string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString() }

async function outbox(connection: PoolConnection, aggregateType: string, aggregateId: string, eventType: string, payload: object) {
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), aggregateType, aggregateId, eventType, JSON.stringify(payload)])
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
