import { randomUUID } from 'node:crypto'
import { assertRiskDecisionWindow } from './mysql-execution-window.js'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TraderAction } from '../../inference/domain/inference.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy, riskPolicyHash, type AccountRiskPolicyPatch, type EffectiveRiskPolicy, type RiskEvaluationResult } from '../../risk/domain/risk.js'
import { executionSourceHash, ExecutionError, sha256Canonical, type ApprovedRiskExecutionSource, type ExecutionIntent, type Operation, type PreparedExecutionBundle, type RiskReservation } from '../domain/execution.js'
import type { ExecutionRepository, ExpirePreparedExecutionInput, PersistPreparedExecutionInput } from '../application/execution-ports.js'

interface SourceRow extends RowDataPacket {
  id: string; trade_decision_id: string; user_id: number; trading_account_id: string; currency: string
  decision_status: 'approved' | 'rejected'; reject_code: string | null; platform_policy_version_id: string
  account_policy_version_id: string | null; policy_set_revision: number; account_risk_revision: number
  manual_release_id: string | null; policy_sha256: string; revision: number; evaluation_json: string | object
  trade_status: string; operation_id: string | null; owned: number
}
interface PolicyRow extends RowDataPacket { set_revision: number; version_id: string; policy_json: string | object; updated_at_utc: Date }
interface ControlRow extends RowDataPacket { kill_switch: number; revision: number }
interface RevisionRow extends RowDataPacket {
  analysis_revision: number; subscription_revision: number; account_revision: number | null
  positions_revision: number | null; pending_orders_revision: number | null; quote_revision: number | null
  contract_revision: number | null; risk_revision: number | null
}
interface CapacityRow extends RowDataPacket {
  open_positions: number; pending_orders: number; total_volume: string; daily_open_count: number; revision: number
}
interface ReservationTotalRow extends RowDataPacket {
  reserved_volume: string | null; reserved_open_positions: string | null; reserved_pending_orders: string | null; reserved_daily_opens: string | null
}
interface OperationRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string | null; kind: Operation['kind']; status: Operation['status']
  source_type: Operation['sourceType']; source_id: string; idempotency_scope: Operation['idempotencyScope']; idempotency_key: string
  request_sha256: string; resource_type: Operation['resourceType']; resource_id: string | null; error_code: string | null
  parent_operation_id: string | null; distribution_id: string | null; result_summary_json: string | object | null
  accepted_at_utc: Date; updated_at_utc: Date; completed_at_utc: Date | null; revision: number
}
interface IntentRow extends RowDataPacket {
  id: string; operation_id: string; risk_decision_id: string | null; trade_decision_id: string | null; user_command_id: string | null; user_id: number; trading_account_id: string
  risk_decision_revision: number | null; account_risk_revision: number
  action_id: string; action_kind: ExecutionIntent['actionKind']; source_type: ExecutionIntent['sourceType']; source_id: string
  idempotency_key: string; request_sha256: string; expected_state_sha256: string; status: ExecutionIntent['status']
  expires_at_utc: Date; error_code: string | null; created_at_utc: Date; updated_at_utc: Date; completed_at_utc: Date | null
  revision: number; action_json: string | object; expected_state_json: string | object; reservation_id: string | null
}
interface ReservationRow extends RowDataPacket {
  id: string; execution_intent_id: string; user_id: number; trading_account_id: string; symbol: string; account_currency: string
  reserved_volume: string; reserved_risk_amount: string; reserved_risk_percent: string; reserved_open_positions: number
  reserved_pending_orders: number; reserved_daily_opens: number; status: RiskReservation['status']; expires_at_utc: Date
  released_at_utc: Date | null; release_reason: string | null; created_at_utc: Date; updated_at_utc: Date; revision: number
}

const sourceSql = `SELECT rd.id,rd.trade_decision_id,rd.user_id,CAST(rd.trading_account_id AS CHAR) trading_account_id,a.currency,
 rd.decision_status,rd.reject_code,CAST(rd.platform_policy_version_id AS CHAR) platform_policy_version_id,
 CAST(rd.account_policy_version_id AS CHAR) account_policy_version_id,rd.policy_set_revision,rd.account_risk_revision,
 rd.manual_release_id,rd.policy_sha256,rd.revision,p.evaluation_json,td.status trade_status,rd.operation_id,
 IF(o.user_id IS NULL,0,1) owned
 FROM risk_decisions_v4 rd
 INNER JOIN risk_decision_payloads_v4 p ON p.risk_decision_id=rd.id
 INNER JOIN trade_decisions td ON td.id=rd.trade_decision_id
 INNER JOIN trading_accounts a ON a.id=rd.trading_account_id AND a.deleted_at_utc IS NULL
 LEFT JOIN trading_account_ownerships o ON o.user_id=rd.user_id AND o.trading_account_id=rd.trading_account_id AND o.role='owner' AND o.revoked_at_utc IS NULL
 WHERE rd.id=?`

export class MysqlExecutionRepository implements ExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async loadApprovedRiskSource(userId: number, riskDecisionId: string) {
    const [rows] = await this.pool.execute<SourceRow[]>(`${sourceSql} AND rd.user_id=? LIMIT 1`, [riskDecisionId, userId])
    const row = rows[0]
    if (!row || row.decision_status !== 'approved' || row.reject_code !== null || row.trade_status !== 'accepted' || !row.owned) return null
    return mapSource(row)
  }

  async persistPreparedExecution(input: PersistPreparedExecutionInput) {
    return transaction(this.pool, async connection => {
      await lockOwnedAccount(connection, input.userId, input.accountId)
      const [existingRows] = await connection.execute<OperationRow[]>(`${operationSelect} WHERE op.idempotency_scope='risk_decision' AND op.idempotency_key=? LIMIT 1 FOR UPDATE`, [`risk_decision:${input.riskDecisionId}`])
      if (existingRows[0]) {
        if (existingRows[0].request_sha256 !== input.sourceHash) throw new ExecutionError('execution_persistence_conflict', 409)
        return loadBundle(connection, existingRows[0].id)
      }

      const [sourceRows] = await connection.execute<SourceRow[]>(`${sourceSql} AND rd.user_id=? LIMIT 1 FOR UPDATE`, [input.riskDecisionId, input.userId])
      const row = sourceRows[0]
      if (!row || row.trading_account_id !== input.accountId || row.decision_status !== 'approved' || row.reject_code !== null
        || row.trade_status !== 'accepted' || row.operation_id || !row.owned) throw new ExecutionError('execution_source_revision_conflict', 409)
      const currentSource = mapSource(row)
      if (currentSource.revision !== input.sourceRevision || currentSource.accountRiskRevision !== input.accountRiskRevision
        || executionSourceHash(currentSource) !== input.sourceHash) throw new ExecutionError('execution_source_revision_conflict', 409)

      const revisions = await currentRevisions(connection, row.trade_decision_id)
      assertExpectedRevisions(currentSource.approvedActions, revisions)
      await assertRiskDecisionWindow(connection, input.riskDecisionId, input.userId, input.accountId, new Date())
      const policy = await effectivePolicy(connection, input.userId, input.accountId)
      if (policy.platformPolicyVersionId !== currentSource.platformPolicyVersionId
        || policy.accountPolicyVersionId !== currentSource.accountPolicyVersionId
        || policy.policySetRevision !== currentSource.policySetRevision
        || riskPolicyHash(policy) !== currentSource.policyHash
        || policy.globalKillSwitch || !policy.values.tradeSendEnabled || policy.values.accountKillSwitch) {
        throw new ExecutionError('execution_policy_revision_conflict', 409)
      }
      const releasedRules = await validateManualRelease(connection, currentSource)
      const capacity = await accountCapacity(connection, input.accountId, currentSource.accountRiskRevision)
      const [reservationRows] = await connection.execute<ReservationTotalRow[]>(`SELECT COALESCE(SUM(reserved_volume),0) reserved_volume,COALESCE(SUM(reserved_open_positions),0) reserved_open_positions,COALESCE(SUM(reserved_pending_orders),0) reserved_pending_orders,COALESCE(SUM(reserved_daily_opens),0) reserved_daily_opens FROM risk_reservations_v4 WHERE trading_account_id=? AND status IN ('active','committed') FOR UPDATE`, [input.accountId])
      assertCapacity(policy, capacity, reservationRows[0]!, input.bundle.reservations, releasedRules)
      const [clockRows] = await connection.execute<(RowDataPacket & { current: number })[]>('SELECT IF(? > UTC_TIMESTAMP(3),1,0) current', [input.bundle.intents[0]!.expiresAt])
      if (!clockRows[0]?.current) throw new ExecutionError('execution_source_expired', 409)

      await insertBundle(connection, input.bundle)
      const [updated] = await connection.execute('UPDATE risk_decisions_v4 SET operation_id=?,revision=revision+1 WHERE id=? AND operation_id IS NULL AND revision=?', [input.bundle.operation.id, input.riskDecisionId, input.sourceRevision])
      if (affectedRows(updated) !== 1) throw new ExecutionError('execution_source_revision_conflict', 409)
      await outbox(connection, 'operation', input.bundle.operation.id, 'operation.changed', operationEvent(input.bundle.operation))
      return input.bundle
    })
  }

  async getOperation(userId: number, operationId: string) {
    const [rows] = await this.pool.execute<OperationRow[]>(`${operationSelect} WHERE op.id=? AND op.user_id=? LIMIT 1`, [operationId, userId])
    return rows[0] ? mapOperation(rows[0], await intentIds(this.pool, operationId)) : null
  }

  async expirePrepared(input: ExpirePreparedExecutionInput) {
    return transaction(this.pool, async connection => {
      const [candidates] = await connection.execute<OperationRow[]>(`${operationSelect}
        WHERE op.status='queued'
          AND NOT EXISTS (SELECT 1 FROM execution_intents other WHERE other.operation_id=op.id AND other.status<>'prepared')
          AND EXISTS (SELECT 1 FROM execution_intents due WHERE due.operation_id=op.id AND due.status='prepared' AND due.expires_at_utc<=?)
        ORDER BY op.updated_at_utc,op.id LIMIT ?`, [input.now, input.limit])
      const accountIds = [...new Set(candidates.map(row => row.trading_account_id).filter((value): value is string => value !== null))]
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
      for (const accountId of accountIds) await connection.execute('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [accountId])
      const expired: Operation[] = []
      for (const candidate of candidates) {
        const [lockedRows] = await connection.execute<OperationRow[]>(`${operationSelect} WHERE op.id=? AND op.status='queued'
          AND NOT EXISTS (SELECT 1 FROM execution_intents other WHERE other.operation_id=op.id AND other.status<>'prepared')
          AND EXISTS (SELECT 1 FROM execution_intents due WHERE due.operation_id=op.id AND due.status='prepared' AND due.expires_at_utc<=?)
          LIMIT 1 FOR UPDATE`, [candidate.id, input.now])
        const row = lockedRows[0]
        if (!row) continue
        await connection.execute(`UPDATE execution_intents SET status='expired',error_code='execution_source_expired',updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE operation_id=? AND status='prepared'`, [input.now, input.now, row.id])
        await connection.execute(`UPDATE risk_reservations_v4 rr INNER JOIN execution_intents ei ON ei.id=rr.execution_intent_id SET rr.status='expired',rr.released_at_utc=?,rr.release_reason='execution_source_expired',rr.updated_at_utc=?,rr.revision=rr.revision+1 WHERE ei.operation_id=? AND rr.status='active'`, [input.now, input.now, row.id])
        await connection.execute(`INSERT INTO execution_intent_events (execution_intent_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) SELECT id,'execution.intent.expired','prepared','expired','execution_source_expired',revision-1,revision,JSON_OBJECT(),? FROM execution_intents WHERE operation_id=? AND status='expired' AND updated_at_utc=?`, [input.now, row.id, input.now])
        await connection.execute(`INSERT INTO risk_reservation_events_v4 (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc) SELECT rr.id,'risk.reservation.expired','active','expired','execution_source_expired',rr.revision-1,rr.revision,? FROM risk_reservations_v4 rr INNER JOIN execution_intents ei ON ei.id=rr.execution_intent_id WHERE ei.operation_id=? AND rr.status='expired' AND rr.updated_at_utc=?`, [input.now, row.id, input.now])
        await connection.execute(`UPDATE operations SET status='expired',error_code='execution_source_expired',updated_at_utc=?,completed_at_utc=?,revision=revision+1 WHERE id=? AND status='queued'`, [input.now, input.now, row.id])
        const [currentRows] = await connection.execute<OperationRow[]>(`${operationSelect} WHERE op.id=?`, [row.id])
        const current = mapOperation(currentRows[0]!, await intentIds(connection, row.id))
        await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,'operation.expired','queued','expired','execution_source_expired',?,?,JSON_OBJECT(),?)`, [row.id, current.revision - 1, current.revision, input.now])
        await outbox(connection, 'operation', row.id, 'operation.changed', operationEvent(current))
        expired.push(current)
      }
      return expired
    })
  }
}

async function insertBundle(connection: PoolConnection, bundle: PreparedExecutionBundle) {
  const op = bundle.operation
  await connection.execute(`INSERT INTO operations (id,user_id,trading_account_id,kind,status,source_type,source_id,idempotency_scope,idempotency_key,request_sha256,resource_type,resource_id,error_code,accepted_at_utc,updated_at_utc,completed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [op.id, op.userId, op.accountId, op.kind, op.status, op.sourceType, op.sourceId, op.idempotencyScope, op.idempotencyKey, op.requestHash, op.resourceType, op.resourceId, op.errorCode, op.acceptedAt, op.updatedAt, op.completedAt, op.revision])
  await connection.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,'operation.queued',NULL,'queued',NULL,NULL,1,JSON_OBJECT(),?)`, [op.id, op.acceptedAt])
  for (const intent of bundle.intents) {
    await connection.execute(`INSERT INTO execution_intents (id,operation_id,risk_decision_id,trade_decision_id,risk_decision_revision,account_risk_revision,user_id,trading_account_id,action_id,action_kind,source_type,source_id,idempotency_key,request_sha256,expected_state_sha256,status,expires_at_utc,error_code,created_at_utc,updated_at_utc,completed_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [intent.id, intent.operationId, intent.riskDecisionId, intent.tradeDecisionId, bundle.sourceRevision, bundle.accountRiskRevision, intent.userId, intent.accountId, intent.actionId, intent.actionKind, intent.sourceType, intent.sourceId, intent.idempotencyKey, intent.requestHash, intent.expectedStateHash, intent.status, intent.expiresAt, intent.errorCode, intent.createdAt, intent.updatedAt, intent.completedAt, intent.revision])
    const actionJson = JSON.stringify(intent.action)
    const expectedJson = JSON.stringify(intent.action.expectedState)
    await connection.execute(`INSERT INTO execution_intent_payloads (execution_intent_id,action_json,action_sha256,expected_state_json,expected_state_sha256,payload_bytes) VALUES (?,?,?,?,?,?)`, [intent.id, actionJson, sha256Canonical(intent.action), expectedJson, intent.expectedStateHash, Buffer.byteLength(actionJson) + Buffer.byteLength(expectedJson)])
    await connection.execute(`INSERT INTO execution_intent_events (execution_intent_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc) VALUES (?,'execution.intent.prepared',NULL,'prepared',NULL,NULL,1,JSON_OBJECT(),?)`, [intent.id, intent.createdAt])
    await outbox(connection, 'execution_intent', intent.id, 'execution.intent.prepared', {
      intent_id: intent.id,
      trading_account_id: intent.accountId,
    })
  }
  for (const reservation of bundle.reservations) {
    await connection.execute(`INSERT INTO risk_reservations_v4 (id,execution_intent_id,user_id,trading_account_id,symbol,account_currency,reserved_volume,reserved_risk_amount,reserved_risk_percent,reserved_open_positions,reserved_pending_orders,reserved_daily_opens,status,expires_at_utc,released_at_utc,release_reason,created_at_utc,updated_at_utc,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [reservation.id, reservation.executionIntentId, reservation.userId, reservation.accountId, reservation.symbol, reservation.accountCurrency, reservation.reservedVolume, reservation.reservedRiskAmount, reservation.reservedRiskPercent, reservation.reservedOpenPositions, reservation.reservedPendingOrders, reservation.reservedDailyOpens, reservation.status, reservation.expiresAt, reservation.releasedAt, reservation.releaseReason, reservation.createdAt, reservation.updatedAt, reservation.revision])
    await connection.execute(`INSERT INTO risk_reservation_events_v4 (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc) VALUES (?,'risk.reservation.activated',NULL,'active',NULL,NULL,1,?)`, [reservation.id, reservation.createdAt])
  }
}

async function loadBundle(connection: PoolConnection, operationId: string): Promise<PreparedExecutionBundle> {
  const [operations] = await connection.execute<OperationRow[]>(`${operationSelect} WHERE op.id=? LIMIT 1`, [operationId])
  const opRow = operations[0]
  if (!opRow) throw new ExecutionError('execution_operation_not_found', 404)
  const [intentRows] = await connection.execute<IntentRow[]>(`SELECT ei.*,p.action_json,p.expected_state_json,rr.id reservation_id FROM execution_intents ei INNER JOIN execution_intent_payloads p ON p.execution_intent_id=ei.id LEFT JOIN risk_reservations_v4 rr ON rr.execution_intent_id=ei.id WHERE ei.operation_id=? ORDER BY ei.id`, [operationId])
  const [reservationRows] = await connection.execute<ReservationRow[]>(`SELECT rr.* FROM risk_reservations_v4 rr INNER JOIN execution_intents ei ON ei.id=rr.execution_intent_id WHERE ei.operation_id=? ORDER BY rr.id`, [operationId])
  const intents = intentRows.map(mapIntent)
  const firstIntent = intentRows[0]
  if (!firstIntent) throw new ExecutionError('execution_persistence_conflict', 409)
  const reservations = reservationRows.map(mapReservation)
  return { kind: 'prepared', sourceHash: opRow.request_sha256, riskDecisionId: opRow.source_id, sourceRevision: Number(firstIntent.risk_decision_revision), accountRiskRevision: Number(firstIntent.account_risk_revision), operation: mapOperation(opRow, intents.map(item => item.id)), intents, reservations }
}

function mapSource(row: SourceRow): ApprovedRiskExecutionSource {
  const evaluation = parse<RiskEvaluationResult>(row.evaluation_json)
  return {
    riskDecisionId: row.id, tradeDecisionId: row.trade_decision_id, userId: Number(row.user_id), accountId: row.trading_account_id,
    accountCurrency: row.currency, status: 'approved', rejectCode: null, platformPolicyVersionId: row.platform_policy_version_id,
    accountPolicyVersionId: row.account_policy_version_id, policySetRevision: Number(row.policy_set_revision),
    accountRiskRevision: Number(row.account_risk_revision), manualReleaseId: evaluation.manualReleaseId,
    manualReleaseRevision: evaluation.manualReleaseRevision, policyHash: row.policy_sha256,
    evaluatedAt: evaluation.evaluatedAt, revision: Number(row.revision), approvedActions: evaluation.approvedActions,
    riskRules: evaluation.rules,
  }
}

async function lockOwnedAccount(connection: PoolConnection, userId: number, accountId: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM trading_accounts a INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE a.id=? AND a.deleted_at_utc IS NULL FOR UPDATE`, [userId, accountId])
  if (!rows[0]) throw new ExecutionError('execution_account_not_owned', 403)
}

async function currentRevisions(connection: PoolConnection, tradeDecisionId: string) {
  const [rows] = await connection.execute<RevisionRow[]>(`SELECT a.revision analysis_revision,s.revision subscription_revision,ars.revision account_revision,pr.revision positions_revision,por.revision pending_orders_revision,q.revision quote_revision,i.revision contract_revision,rs.revision risk_revision FROM trade_decisions d INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id INNER JOIN market_analyses a ON a.id=d.market_analysis_id INNER JOIN strategy_subscriptions s ON s.id=r.subscription_id LEFT JOIN account_runtime_snapshots ars ON ars.trading_account_id=d.trading_account_id LEFT JOIN trading_projection_revisions pr ON pr.trading_account_id=d.trading_account_id AND pr.resource_kind='positions' AND pr.resource_id='open' LEFT JOIN trading_projection_revisions por ON por.trading_account_id=d.trading_account_id AND por.resource_kind='pending_orders' AND por.resource_id='open' LEFT JOIN market_quotes q ON q.trading_account_id=d.trading_account_id AND q.symbol=a.standard_symbol LEFT JOIN market_instrument_snapshots i ON i.trading_account_id=d.trading_account_id AND i.symbol=a.standard_symbol LEFT JOIN account_risk_summaries rs ON rs.trading_account_id=d.trading_account_id WHERE d.id=? LIMIT 1 FOR SHARE`, [tradeDecisionId])
  if (!rows[0]) throw new ExecutionError('execution_context_incomplete', 409)
  return {
    analysis: Number(rows[0].analysis_revision), subscription: Number(rows[0].subscription_revision), account: Number(rows[0].account_revision),
    positions: Number(rows[0].positions_revision ?? 0), pendingOrders: Number(rows[0].pending_orders_revision ?? 0),
    quote: Number(rows[0].quote_revision), contract: Number(rows[0].contract_revision), risk: Number(rows[0].risk_revision),
  }
}

function assertExpectedRevisions(actions: TraderAction[], current: Record<string, number>) {
  for (const action of actions) for (const [key, revision] of Object.entries(current)) {
    if (action.expectedState[`${key}Revision`] !== revision) throw new ExecutionError('execution_expected_state_stale', 409)
  }
}

async function effectivePolicy(connection: PoolConnection, userId: number, accountId: string): Promise<EffectiveRiskPolicy> {
  const [platformRows] = await connection.execute<PolicyRow[]>(policySelect("p.scope='platform'"))
  const [accountRows] = await connection.execute<PolicyRow[]>(policySelect("p.scope='account' AND p.owner_user_id=? AND p.trading_account_id=?"), [userId, accountId])
  const [controls] = await connection.execute<ControlRow[]>('SELECT kill_switch,revision FROM global_risk_controls WHERE id=1 FOR SHARE')
  const platform = platformRows[0]
  if (!platform) throw new ExecutionError('execution_policy_missing', 409)
  const account = accountRows[0]
  return resolveRiskPolicy({
    accountId, userId, platformPolicyVersionId: platform.version_id, accountPolicyVersionId: account?.version_id ?? null,
    policySetRevision: Number(account?.set_revision ?? 0),
    platform: { values: platformValues(platform.policy_json), globalKillSwitch: Boolean(controls[0]?.kill_switch), revision: Number(controls[0]?.revision ?? 0) },
    account: account ? parse<AccountRiskPolicyPatch>(account.policy_json) : null,
    updatedAt: new Date(account?.updated_at_utc ?? platform.updated_at_utc).toISOString(),
  })
}

function policySelect(where: string) {
  return `SELECT p.revision set_revision,CAST(v.id AS CHAR) version_id,v.policy_json,p.updated_at_utc FROM risk_policy_sets_v4 p INNER JOIN risk_policy_versions_v4 v ON v.id=p.active_version_id AND v.policy_set_id=p.id WHERE p.status='active' AND ${where} LIMIT 1 FOR SHARE`
}

function platformValues(value: string | object) {
  const parsed = parse<Partial<typeof DEFAULT_RISK_POLICY> & { values?: Partial<typeof DEFAULT_RISK_POLICY> }>(value)
  return { ...DEFAULT_RISK_POLICY, ...(parsed.values ?? parsed), allowedSymbols: [...(parsed.values?.allowedSymbols ?? parsed.allowedSymbols ?? DEFAULT_RISK_POLICY.allowedSymbols)], requireStopLoss: true as const, failClosedOnIncompleteData: true as const }
}

async function validateManualRelease(connection: PoolConnection, source: ApprovedRiskExecutionSource) {
  if (!source.manualReleaseId) return new Set<string>()
  const [rows] = await connection.execute<(RowDataPacket & { revision: number; released_rules_json: string | object; platform_policy_version_id: string; account_policy_version_id: string | null; policy_set_revision: number })[]>(`SELECT revision,released_rules_json,CAST(platform_policy_version_id AS CHAR) platform_policy_version_id,CAST(account_policy_version_id AS CHAR) account_policy_version_id,policy_set_revision FROM risk_manual_releases WHERE id=? AND user_id=? AND trading_account_id=? AND status='active' AND expires_at_utc>UTC_TIMESTAMP(3) LIMIT 1 FOR SHARE`, [source.manualReleaseId, source.userId, source.accountId])
  const row = rows[0]
  if (!row || Number(row.revision) !== source.manualReleaseRevision || row.platform_policy_version_id !== source.platformPolicyVersionId
    || row.account_policy_version_id !== source.accountPolicyVersionId || Number(row.policy_set_revision) !== source.policySetRevision) throw new ExecutionError('execution_manual_release_conflict', 409)
  return new Set(parse<string[]>(row.released_rules_json))
}

async function accountCapacity(connection: PoolConnection, accountId: string, revision: number) {
  const [rows] = await connection.execute<CapacityRow[]>('SELECT open_positions,pending_orders,total_volume,daily_open_count,revision FROM account_risk_states WHERE trading_account_id=? FOR UPDATE', [accountId])
  const row = rows[0]
  if (!row || Number(row.revision) !== revision) throw new ExecutionError('execution_risk_revision_conflict', 409)
  return row
}

function assertCapacity(policy: EffectiveRiskPolicy, current: CapacityRow, active: ReservationTotalRow, next: RiskReservation[], releasedRules: Set<string>) {
  const add = next.reduce((sum, item) => ({ volume: sum.volume + item.reservedVolume, open: sum.open + item.reservedOpenPositions, pending: sum.pending + item.reservedPendingOrders, daily: sum.daily + item.reservedDailyOpens }), { volume: 0, open: 0, pending: 0, daily: 0 })
  const activeVolume = Number(active.reserved_volume ?? 0); const activeOpen = Number(active.reserved_open_positions ?? 0)
  const activePending = Number(active.reserved_pending_orders ?? 0); const activeDaily = Number(active.reserved_daily_opens ?? 0)
  const dailyLimit = releasedRules.has('RISK_DAILY_OPEN_LIMIT') ? policy.values.manualReleaseMaxDailyOpenCount : policy.values.maxDailyOpenCount
  if (Number(current.total_volume) + activeVolume + add.volume > policy.values.maxTotalVolume + 1e-9
    || Number(current.open_positions) + activeOpen + add.open > policy.values.maxOpenPositions
    || Number(current.pending_orders) + activePending + add.pending > policy.values.maxPendingOrders
    || Number(current.daily_open_count) + activeDaily + add.daily > dailyLimit) throw new ExecutionError('execution_capacity_exceeded', 409)
}

const operationSelect = `SELECT op.id,op.user_id,CAST(op.trading_account_id AS CHAR) trading_account_id,op.kind,op.status,op.source_type,op.source_id,op.idempotency_scope,op.idempotency_key,op.request_sha256,op.resource_type,op.resource_id,op.parent_operation_id,op.distribution_id,op.result_summary_json,op.error_code,op.accepted_at_utc,op.updated_at_utc,op.completed_at_utc,op.revision FROM operations op`

function mapOperation(row: OperationRow, ids: string[]): Operation {
  return { id: row.id, userId: Number(row.user_id), accountId: row.trading_account_id, kind: row.kind, status: row.status, sourceType: row.source_type, sourceId: row.source_id, idempotencyScope: row.idempotency_scope, idempotencyKey: row.idempotency_key, requestHash: row.request_sha256, resourceType: row.resource_type, resourceId: row.resource_id, errorCode: row.error_code, acceptedAt: iso(row.accepted_at_utc), updatedAt: iso(row.updated_at_utc), completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null, revision: Number(row.revision), intentIds: ids, parentOperationId: row.parent_operation_id, distributionId: row.distribution_id, resultSummary: row.result_summary_json === null ? null : parse(row.result_summary_json) }
}

function mapIntent(row: IntentRow): ExecutionIntent {
  const action = parse<TraderAction>(row.action_json)
  return { id: row.id, operationId: row.operation_id, riskDecisionId: row.risk_decision_id, tradeDecisionId: row.trade_decision_id, userId: Number(row.user_id), accountId: row.trading_account_id, actionId: row.action_id, actionKind: row.action_kind, action, sourceType: row.source_type, sourceId: row.source_id, idempotencyKey: row.idempotency_key, requestHash: row.request_sha256, expectedStateHash: row.expected_state_sha256, status: row.status, expiresAt: iso(row.expires_at_utc), createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc), completedAt: row.completed_at_utc ? iso(row.completed_at_utc) : null, errorCode: row.error_code, revision: Number(row.revision), riskReservationId: row.reservation_id, userCommandId: row.user_command_id }
}

function mapReservation(row: ReservationRow): RiskReservation {
  return { id: row.id, executionIntentId: row.execution_intent_id, userId: Number(row.user_id), accountId: row.trading_account_id, symbol: row.symbol, accountCurrency: row.account_currency, reservedVolume: Number(row.reserved_volume), reservedRiskAmount: Number(row.reserved_risk_amount), reservedRiskPercent: Number(row.reserved_risk_percent), reservedOpenPositions: Number(row.reserved_open_positions), reservedPendingOrders: Number(row.reserved_pending_orders), reservedDailyOpens: Number(row.reserved_daily_opens), status: row.status, expiresAt: iso(row.expires_at_utc), releasedAt: row.released_at_utc ? iso(row.released_at_utc) : null, releaseReason: row.release_reason, createdAt: iso(row.created_at_utc), updatedAt: iso(row.updated_at_utc), revision: Number(row.revision) }
}

async function intentIds(executor: Pool | PoolConnection, operationId: string) {
  const [rows] = await executor.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM execution_intents WHERE operation_id=? ORDER BY id', [operationId])
  return rows.map(row => row.id)
}

async function outbox(connection: PoolConnection, aggregateType: string, aggregateId: string, eventType: string, payload: object) {
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(), aggregateType, aggregateId, eventType, JSON.stringify(payload)])
}

function operationEvent(operation: Operation) { return { operation_id: operation.id, kind: operation.kind, status: operation.status, updated_at: operation.updatedAt, revision: String(operation.revision) } }
function parse<T>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }
function iso(value: Date | string) { return new Date(value).toISOString() }
function affectedRows(value: unknown) { return Number((value as { affectedRows?: number }).affectedRows ?? 0) }

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
