import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import type { ExecutionAction } from '../domain/execution-input.js'
import { buildPartialClosePlan } from '../domain/partial-close-plan.js'
import { partialCloseVolumeEquals } from '../domain/partial-close-protection.js'
import { sha256Canonical } from '../domain/execution.js'
import type { PartialCloseRegistrationTargetReader } from '../application/partial-close-workflow-store.js'

const parse = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value
function fail(code: string): never { throw new BridgeCommandError(`partial_close_dispatch_${code}`, 409) }

/** Frozen registration plus current locked target only. The caller must separately admit current risk before dispatch. */
export async function readPartialCloseParentDispatch(db: PoolConnection, command: BridgeCommand, action: ExecutionAction,
  intentExpiresAt: number, targets: PartialCloseRegistrationTargetReader) {
  const plan = buildPartialClosePlan(command, action, intentExpiresAt)
  if (!plan || command.status !== 'queued') return fail('plan_invalid')
  const [clocks] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const now = Number(clocks[0]?.now_msc)
  if (!['+00:00', 'UTC'].includes(String(clocks[0]?.zone)) || !Number.isSafeInteger(now) || now < Date.parse(command.issuedAt)
    || now >= plan.expiresAt || now >= Date.parse(command.deadlineAt)) fail('clock_or_deadline_invalid')
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT id,parent_intent_id,parent_command_id,user_id,
    CAST(trading_account_id AS CHAR) account_id,plan_json,plan_sha256,status,revision
    FROM partial_close_workflows_v4 WHERE parent_command_id=? FOR UPDATE`, [command.id])
  const row = rows[0], planHash = sha256Canonical(plan)
  if (rows.length !== 1 || !row || row.id !== plan.workflowId || row.parent_intent_id !== command.executionIntentId
    || row.parent_command_id !== command.id || row.user_id !== command.userId || row.account_id !== command.accountId
    || row.plan_sha256 !== planHash || sha256Canonical(parse(row.plan_json)) !== planHash
    || row.status !== 'awaiting_close' || Number(row.revision) !== 1) fail('registration_invalid')
  const [events] = await db.execute<RowDataPacket[]>(`SELECT revision,event_type,payload_json,payload_sha256
    FROM partial_close_workflow_events_v4 WHERE workflow_id=? ORDER BY revision FOR SHARE`, [plan.workflowId])
  const expected = sha256Canonical({ planHash, parentIntentId: plan.parentIntentId, parentCommandId: plan.parentCommandId })
  if (events.length !== 1 || Number(events[0]!.revision) !== 1 || events[0]!.event_type !== 'registered'
    || events[0]!.payload_sha256 !== expected || sha256Canonical(parse(events[0]!.payload_json)) !== expected) fail('registration_audit_invalid')
  const current = await targets.read({ target: structuredClone(plan.target), revision: plan.initialRevision, connectionEpoch: command.route.connectionEpoch })
  if (!current || sha256Canonical(current.target) !== sha256Canonical(plan.target) || current.revision !== plan.initialRevision
    || !partialCloseVolumeEquals(current.volume, plan.initialVolume)) fail('target_changed')
  return { plan, planHash, evaluatedAt: now }
}
