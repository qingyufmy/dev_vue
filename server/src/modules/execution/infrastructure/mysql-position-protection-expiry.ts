import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import type { PositionProtectionPreparationResult } from '../application/position-protection-preparation.js'
import { sha256Canonical } from '../domain/execution.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

export interface PositionProtectionExpiry {
  planHash: string
  requestHash: string
  deadline: number
  expiredAt: string
  reason: 'protection_deadline_elapsed'
}
function fail(code: string): never { throw new BridgeCommandError(`position_protection_${code}`,409) }

/** Requires the caller's account/workflow/parent locks and absence of a review receipt. */
export async function assertPositionProtectionNotPrepared(db: PoolConnection, workflowId: string): Promise<void> {
  const [children] = await db.execute<RowDataPacket[]>(`SELECT id FROM execution_intents
    WHERE position_workflow_id=? OR (source_type='position_workflow' AND source_id=?) LIMIT 1 FOR SHARE`, [workflowId,workflowId])
  const [operations] = await db.execute<RowDataPacket[]>(`SELECT id FROM operations WHERE source_type='position_workflow' AND source_id=? LIMIT 1 FOR SHARE`, [workflowId])
  if (children.length || operations.length) fail('unreceipted_child')
}

export function verifyPositionProtectionExpiry(event: RowDataPacket | undefined, planHash: string, requestHash: string, deadline: number, now: Date): void {
  if (!event || Number(event.revision) !== 3 || event.event_type !== 'expired') fail('expiry_corrupt')
  const payload = (typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json) as PositionProtectionExpiry
  const time = Date.parse(payload?.expiredAt)
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== payload.expiredAt || time < deadline || time > now.getTime()
    || event.payload_sha256 !== sha256Canonical(payload)
    || event.payload_sha256 !== sha256Canonical({planHash,requestHash,deadline,expiredAt:payload.expiredAt,reason:'protection_deadline_elapsed'})) fail('expiry_corrupt')
}

export async function expirePositionProtection(db: PoolConnection, scope: PartialCloseWorkflowScope,
  planHash: string, requestHash: string, deadline: number, now: Date): Promise<PositionProtectionPreparationResult> {
  if (!Number.isSafeInteger(deadline) || now.getTime() < deadline) fail('expiry_not_due')
  await assertPositionProtectionNotPrepared(db,scope.workflowId)
  const expiredAt = now.toISOString(), sqlTime = bridgeCommandSqlTime(expiredAt)
  const event: PositionProtectionExpiry = {planHash,requestHash,deadline,expiredAt,reason:'protection_deadline_elapsed'}
  const [updated] = await db.execute<ResultSetHeader>(`UPDATE partial_close_workflows_v4 SET status='expired',revision=3,updated_at_utc=?
    WHERE id=? AND revision=2 AND status='risk_review_required'`, [sqlTime,scope.workflowId])
  if (updated.affectedRows !== 1) fail('revision_conflict')
  await db.execute(`INSERT INTO partial_close_workflow_events_v4 (workflow_id,revision,event_type,payload_json,payload_sha256,occurred_at_utc)
    VALUES (?,3,'expired',?,?,?)`, [scope.workflowId,JSON.stringify(event),sha256Canonical(event),sqlTime])
  await db.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'partial_close_workflow',?,'execution.partial-close.expired',?,'pending',0,?,?)`,
  [randomUUID(),scope.workflowId,JSON.stringify({workflow_id:scope.workflowId,user_id:scope.userId,trading_account_id:scope.accountId,revision:3}),sqlTime,sqlTime])
  return {workflowId:scope.workflowId,revision:3,status:'expired',childIntentId:null,rejectCode:null,replayed:false}
}
