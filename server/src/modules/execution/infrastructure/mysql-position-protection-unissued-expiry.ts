import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PositionProtectionChild } from '../domain/position-protection-child.js'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { sha256Canonical } from '../domain/execution.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

const reason = 'command_not_created_before_expiry' as const
const outcome = { state: 'stopped' as const, reason }
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
function fail(): never { throw new BridgeCommandError('position_protection_unissued_expiry_invalid', 409) }
async function assertAbsent(db: PoolConnection, childId: string) {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM bridge_commands_v4 WHERE execution_intent_id=? FOR UPDATE', [childId])
  if (rows.length) fail()
}

/** Account and original child locks are held by the outcome transaction. */
export async function expireUnissuedPositionProtection(db: PoolConnection, child: PositionProtectionChild) {
  await assertAbsent(db, child.intent.id)
  const [clock] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const now = Number(clock[0]?.now_msc), expiry = Date.parse(child.intent.expiresAt)
  if (!['+00:00', 'UTC'].includes(String(clock[0]?.zone)) || !Number.isSafeInteger(now) || !Number.isSafeInteger(expiry)) fail()
  if (now < expiry) return { outcome: { state: 'waiting' as const, reason: 'command_queued' as const }, revision: 3, replayed: false }
  const evidence = { child, expiredAt: now }, hash = sha256Canonical(evidence), at = bridgeCommandSqlTime(new Date(now).toISOString())
  const json = JSON.stringify(evidence)
  if (Buffer.byteLength(json) > 1024 * 1024) fail()
  const [intent] = await db.execute<ResultSetHeader>(`UPDATE execution_intents SET status='expired',error_code=?,revision=2,updated_at_utc=?,completed_at_utc=?
    WHERE id=? AND status='prepared' AND revision=1`, [reason, at, at, child.intent.id])
  const [operation] = await db.execute<ResultSetHeader>(`UPDATE operations SET status='expired',error_code=?,revision=2,updated_at_utc=?,completed_at_utc=?
    WHERE id=? AND status='queued' AND revision=1`, [reason, at, at, child.operation.id])
  if (intent.affectedRows !== 1 || operation.affectedRows !== 1) fail()
  const payload = JSON.stringify({ expiryHash: hash })
  await db.execute(`INSERT INTO execution_intent_events (execution_intent_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc)
    VALUES (?,'execution.intent.expired','prepared','expired',?,1,2,?,?)`, [child.intent.id, reason, payload, at])
  await db.execute(`INSERT INTO operation_events (operation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,payload_json,occurred_at_utc)
    VALUES (?,'operation.expired','queued','expired',?,1,2,?,?)`, [child.operation.id, reason, payload, at])
  await db.execute('INSERT INTO position_protection_unissued_expiries_v4 VALUES (?,?,?,?,?)', [child.request.workflowId, child.intent.id, json, hash, at])
  const [workflow] = await db.execute<ResultSetHeader>(`UPDATE partial_close_workflows_v4 SET status='stopped',revision=4,updated_at_utc=?
    WHERE id=? AND status='protecting' AND revision=3`, [at, child.request.workflowId])
  if (workflow.affectedRows !== 1) fail()
  const event = { expiryHash: hash, childIntentId: child.intent.id, outcome }
  await db.execute("INSERT INTO partial_close_workflow_events_v4 VALUES (?,4,'stopped',?,?,?)", [child.request.workflowId, JSON.stringify(event), sha256Canonical(event), at])
  for (const [type, aggregate, id, body] of [
    ['execution.partial-close.progressed', 'partial_close_workflow', child.request.workflowId,
      { workflow_id: child.request.workflowId, user_id: child.request.userId, trading_account_id: child.request.accountId, revision: 4 }],
    ['operation.changed', 'operation', child.operation.id,
      { operation_id: child.operation.id, status: 'expired', revision: '2', updated_at: new Date(now).toISOString() }],
  ] as const) await db.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,?,?,?,?,'pending',0,?,?)`, [randomUUID(), aggregate, id, type, JSON.stringify(body), at, at])
  return { outcome, revision: 4, replayed: false }
}

export async function readUnissuedPositionProtectionExpiry(db: PoolConnection, scope: PartialCloseWorkflowScope) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT r.*,p.child_sha256,w.status,w.revision,w.user_id,CAST(w.trading_account_id AS CHAR) account_id,
    i.status intent_status,i.revision intent_revision,i.error_code intent_error,o.status operation_status,o.revision operation_revision,o.error_code operation_error,
    UNIX_TIMESTAMP(r.created_at_utc)*1000 receipt_msc,UNIX_TIMESTAMP(i.completed_at_utc)*1000 intent_msc,UNIX_TIMESTAMP(o.completed_at_utc)*1000 operation_msc
    FROM position_protection_unissued_expiries_v4 r JOIN position_protection_reviews_v4 p ON p.workflow_id=r.workflow_id AND p.child_intent_id=r.child_intent_id
    JOIN partial_close_workflows_v4 w ON w.id=r.workflow_id JOIN execution_intents i ON i.id=r.child_intent_id
    JOIN operations o ON o.id=i.operation_id WHERE r.workflow_id=? FOR SHARE`, [scope.workflowId])
  if (!rows.length) return null
  const row = rows[0]!, evidence = parse<{ child: PositionProtectionChild; expiredAt: number }>(row.evidence_json), child = evidence.child
  if (rows.length !== 1 || row.user_id !== scope.userId || row.account_id !== scope.accountId || row.status !== 'stopped' || Number(row.revision) !== 4
    || sha256Canonical(evidence) !== row.evidence_sha256 || sha256Canonical(child) !== row.child_sha256 || child.intent.id !== row.child_intent_id
    || child.request.workflowId !== scope.workflowId || child.request.userId !== scope.userId || child.request.accountId !== scope.accountId
    || !Number.isSafeInteger(evidence.expiredAt) || !Number.isSafeInteger(Date.parse(child.intent.expiresAt)) || evidence.expiredAt < Date.parse(child.intent.expiresAt)
    || [row.receipt_msc, row.intent_msc, row.operation_msc].some(value => Number(value) !== evidence.expiredAt)
    || row.intent_status !== 'expired' || Number(row.intent_revision) !== 2 || row.intent_error !== reason
    || row.operation_status !== 'expired' || Number(row.operation_revision) !== 2 || row.operation_error !== reason) fail()
  await assertAbsent(db, child.intent.id)
  for (const [table, column, id, from] of [
    ['execution_intent_events', 'execution_intent_id', child.intent.id, 'prepared'],
    ['operation_events', 'operation_id', child.operation.id, 'queued'],
  ] as const) {
    const [audit] = await db.execute<RowDataPacket[]>(`SELECT from_status,to_status,from_revision,to_revision,reason_code,payload_json,
      UNIX_TIMESTAMP(occurred_at_utc)*1000 at FROM ${table} WHERE ${column}=? AND to_revision=2 FOR SHARE`, [id])
    if (audit.length !== 1 || audit[0]!.from_status !== from || audit[0]!.to_status !== 'expired' || Number(audit[0]!.from_revision) !== 1
      || audit[0]!.reason_code !== reason || Number(audit[0]!.at) !== evidence.expiredAt
      || sha256Canonical(parse(audit[0]!.payload_json)) !== sha256Canonical({ expiryHash: row.evidence_sha256 })) fail()
  }
  const event = { expiryHash: row.evidence_sha256, childIntentId: child.intent.id, outcome }
  const [events] = await db.execute<RowDataPacket[]>('SELECT event_type,payload_json,payload_sha256 FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision=4 FOR SHARE', [scope.workflowId])
  if (events.length !== 1 || events[0]!.event_type !== 'stopped' || events[0]!.payload_sha256 !== sha256Canonical(event)
    || sha256Canonical(parse(events[0]!.payload_json)) !== events[0]!.payload_sha256) fail()
  return { outcome, revision: 4 }
}
