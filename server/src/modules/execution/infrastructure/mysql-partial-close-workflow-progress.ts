import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PartialCloseProgressFacts, PartialCloseProgressResult, PartialCloseWorkflowProgress, PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import { evaluatePartialCloseProtection, type PartialCloseProtectionPlan, type ProtectionEligibility } from '../domain/partial-close-protection.js'
import { sha256Canonical } from '../domain/execution.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { bridgeCommandTransaction } from './bridge-command-transaction.js'
import { readPositionProtectionPreparation } from './mysql-position-protection-preparation.js'

interface WorkflowRow extends RowDataPacket {
  id: string; user_id: number; trading_account_id: string; parent_intent_id: string; parent_command_id: string
  status: PartialCloseProgressResult['status']; revision: number | string; plan_json: string | PartialCloseProtectionPlan; plan_sha256: string
}
const columns = 'id,user_id,CAST(trading_account_id AS CHAR) trading_account_id,parent_intent_id,parent_command_id,status,revision,plan_json,plan_sha256'
const parse = <T>(value: string | T): T => typeof value === 'string' ? JSON.parse(value) as T : value
function fail(code: string): never { throw new BridgeCommandError(code, 409) }
function assertScope(scope: PartialCloseWorkflowScope) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.workflowId)
    || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
    || !/^[1-9][0-9]{0,19}$/.test(scope.accountId) || BigInt(scope.accountId) > 18446744073709551615n) fail('partial_close_progress_scope_invalid')
}

export type CapturePartialCloseProgressFacts = (scope: PartialCloseWorkflowScope) => Promise<(connection: PoolConnection) => PartialCloseProgressFacts>

/** Route capture precedes the transaction. Every fact reader returned by it must use this same connection. */
export function createMysqlPartialCloseWorkflowProgress(pool: Pool, capture: CapturePartialCloseProgressFacts, maxProjectionAgeMs: number): PartialCloseWorkflowProgress {
  if (!Number.isSafeInteger(maxProjectionAgeMs) || maxProjectionAgeMs < 1 || maxProjectionAgeMs > 60_000) fail('partial_close_projection_age_invalid')
  return { async advance(input) {
    const scope = structuredClone(input)
    assertScope(scope)
    const facts = await capture(structuredClone(scope))
    return bridgeCommandTransaction(pool, connection => advance(connection, scope, facts(connection), maxProjectionAgeMs))
  } }
}

async function advance(connection: PoolConnection, scope: PartialCloseWorkflowScope, facts: PartialCloseProgressFacts, maxProjectionAgeMs: number): Promise<PartialCloseProgressResult> {
  const [accounts] = await connection.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [scope.accountId])
  if (accounts.length !== 1) fail('partial_close_progress_not_found')
  const [locators] = await connection.execute<WorkflowRow[]>(`SELECT ${columns} FROM partial_close_workflows_v4 WHERE id=? AND user_id=? AND trading_account_id=?`, [scope.workflowId,scope.userId,scope.accountId])
  const locator = locators[0]
  if (!locator) fail('partial_close_progress_not_found')
  const [intents] = await connection.execute<RowDataPacket[]>('SELECT id,user_id,trading_account_id,action_kind,status FROM execution_intents WHERE id=? FOR UPDATE', [locator.parent_intent_id])
  const [commands] = await connection.execute<RowDataPacket[]>('SELECT id,execution_intent_id,user_id,trading_account_id,action,status FROM bridge_commands_v4 WHERE id=? FOR UPDATE', [locator.parent_command_id])
  const [workflows] = await connection.execute<WorkflowRow[]>(`SELECT ${columns} FROM partial_close_workflows_v4 WHERE id=? FOR UPDATE`, [scope.workflowId])
  const row = workflows[0], intent = intents[0], command = commands[0]
  if (!row || row.parent_intent_id !== locator.parent_intent_id || row.parent_command_id !== locator.parent_command_id
    || row.user_id !== scope.userId || String(row.trading_account_id) !== scope.accountId
    || !intent || !command || intent.user_id !== scope.userId || command.user_id !== scope.userId
    || String(intent.trading_account_id) !== scope.accountId || String(command.trading_account_id) !== scope.accountId
    || command.execution_intent_id !== intent.id || intent.action_kind !== 'close_position' || command.action !== 'position.close') fail('partial_close_progress_parent_mismatch')
  const plan = parse(row.plan_json), revision = Number(row.revision)
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER
    || sha256Canonical(plan) !== row.plan_sha256 || plan.workflowId !== row.id || plan.parentIntentId !== intent.id || plan.parentCommandId !== command.id
    || plan.target.userId !== String(scope.userId) || plan.target.accountId !== scope.accountId) fail('partial_close_progress_plan_corrupt')
  const [events] = await connection.execute<RowDataPacket[]>('SELECT revision,event_type,payload_json,payload_sha256 FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision IN (1,2,?) ORDER BY revision FOR SHARE', [row.id,revision])
  const registered = { planHash: row.plan_sha256, parentIntentId: plan.parentIntentId, parentCommandId: plan.parentCommandId }
  const first = events[0], latest = events.at(-1)
  if (!first || Number(first.revision) !== 1 || first.event_type !== 'registered' || first.payload_sha256 !== sha256Canonical(registered)
    || sha256Canonical(parse(first.payload_json)) !== first.payload_sha256 || !latest || Number(latest.revision) !== revision
    || sha256Canonical(parse(latest.payload_json)) !== latest.payload_sha256) fail('partial_close_progress_audit_corrupt')
  if (row.status !== 'awaiting_close') {
    if ((revision === 3 && ['protecting','stopped','expired'].includes(row.status))
      || (revision === 4 && ['succeeded','stopped'].includes(row.status))) {
      const result = await readPositionProtectionPreparation(connection,scope)
      const qualification = events.find(event => Number(event.revision) === 2)
      if (!qualification) fail('partial_close_progress_audit_corrupt')
      // The replay reader verifies this event, the receipt and the actual child on this connection.
      const saved = parse<{ assessment: ProtectionEligibility }>(qualification.payload_json)
      return { workflowId: row.id, revision: result.revision, status: result.status, assessment: structuredClone(saved.assessment), replayed: true }
    }
    const saved = parse<{ planHash: string; assessment: ProtectionEligibility }>(latest.payload_json)
    if (!['risk_review_required','stopped','expired'].includes(row.status) || latest.event_type !== row.status
      || saved.planHash !== row.plan_sha256 || saved.assessment?.state !== row.status) fail('partial_close_progress_state_invalid')
    return { workflowId: row.id, revision, status: row.status, assessment: structuredClone(saved.assessment), replayed: true }
  }
  if (revision !== 1) fail('partial_close_progress_state_invalid')
  let parentState: 'pending' | 'uncertain' | 'succeeded' | 'failed'
  if (['uncertain','reconciling'].includes(command.status)) parentState = 'uncertain'
  else if (['failed','rejected'].includes(command.status)) parentState = 'failed'
  else if (command.status === 'succeeded' && intent.status === 'succeeded') parentState = 'succeeded'
  else if (['queued','dispatched','accepted'].includes(command.status)) parentState = 'pending'
  else fail('partial_close_progress_parent_state_invalid')
  let now = await utcNow(connection)
  const history = parentState === 'succeeded' && now < plan.expiresAt ? await facts.history.read(structuredClone(plan)) : null
  if (history && sha256Canonical(history.evidence) !== history.evidenceHash) fail('partial_close_progress_history_corrupt')
  const projection = history ? await facts.projection.read(structuredClone(plan)) : null
  if (history) now = await utcNow(connection)
  const assessment = evaluatePartialCloseProtection({ plan, parentState, history, projection, now, maxProjectionAgeMs })
  if (assessment.state === 'stopped' && assessment.reason === 'invalid_plan') fail('partial_close_progress_plan_corrupt')
  if (!['risk_review_required','stopped','expired'].includes(assessment.state)) {
    return { workflowId: row.id, revision, status: 'awaiting_close', assessment, replayed: false }
  }
  const status = assessment.state as 'risk_review_required' | 'stopped' | 'expired'
  const event = { planHash: row.plan_sha256, assessment, history,
    projectionHash: projection ? sha256Canonical(projection) : null }
  const payload = JSON.stringify(event)
  if (Buffer.byteLength(payload) > 1024 * 1024) fail('partial_close_progress_evidence_too_large')
  const [updated] = await connection.execute<ResultSetHeader>(`UPDATE partial_close_workflows_v4 SET status=?,revision=revision+1,updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND revision=? AND status='awaiting_close'`, [status,row.id,revision])
  if (updated.affectedRows !== 1) fail('partial_close_progress_revision_conflict')
  await connection.execute(`INSERT INTO partial_close_workflow_events_v4 (workflow_id,revision,event_type,payload_json,payload_sha256,occurred_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`, [row.id,revision+1,status,payload,sha256Canonical(event)])
  await connection.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'partial_close_workflow',?,'execution.partial-close.progressed',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
  [randomUUID(),row.id,JSON.stringify({ workflow_id: row.id, user_id: scope.userId, trading_account_id: scope.accountId, revision: revision+1 })])
  return { workflowId: row.id, revision: revision+1, status, assessment, replayed: false }
}

async function utcNow(connection: PoolConnection): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  if (!['+00:00','UTC'].includes(String(rows[0]?.zone))) fail('partial_close_utc_required')
  const now = Number(rows[0]!.now_msc)
  if (!Number.isSafeInteger(now) || now < 1) fail('partial_close_progress_clock_invalid')
  return now
}
