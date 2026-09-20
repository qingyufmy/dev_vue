import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { PartialCloseRegistrationTargetReader, PartialCloseWorkflowRegistration, PartialCloseWorkflowWriter } from '../application/partial-close-workflow-store.js'
import { evaluatePartialCloseProtection, type PartialCloseProtectionPlan } from '../domain/partial-close-protection.js'
import { canonicalHash, type BridgeCommandRequestEnvelope } from '../domain/bridge-command.js'
import { sha256Canonical } from '../domain/execution.js'

interface ParentRow extends RowDataPacket {
  intent_id: string; command_id: string; user_id: number; trading_account_id: string; intent_user_id: number; intent_account_id: string
  intent_status: string; intent_expires_at: Date; command_deadline_at: Date
  action_kind: string; status: string; action: string; terminal_instance_id: string; broker_server: string; account_login: string
  request_sha256: string; request_envelope_json: string | BridgeCommandRequestEnvelope
  action_json: string | { kind: string; parameters: Record<string, unknown>; expectedState: Record<string, unknown> }
  action_sha256: string; connection_epoch: number | string
}
interface RegistrationRow extends RowDataPacket {
  id: string; parent_intent_id: string; parent_command_id: string; user_id: number; trading_account_id: string
  plan_json: string | PartialCloseProtectionPlan; plan_sha256: string
  status: PartialCloseWorkflowRegistration['status']; revision: number | string
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const parse = <T>(value: string | T): T => typeof value === 'string' ? JSON.parse(value) as T : value
const decimal = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value)
  ? value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value : null
const matchVolume = (left: unknown, right: unknown) => decimal(left) !== null && decimal(left) === decimal(right)
function invalid(code: string): never { throw new Error(code) }

/** No BEGIN/COMMIT or external I/O: registration belongs to the command preparation transaction. */
export function createMysqlPartialCloseWorkflowWriter(connection: PoolConnection,
  targetReader: PartialCloseRegistrationTargetReader): PartialCloseWorkflowWriter {
  return { async register(source) {
    const plan = structuredClone(source)
    const [context] = await connection.query<RowDataPacket[]>(`SELECT @@session.time_zone zone, UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc`)
    if (!['+00:00', 'UTC'].includes(String(context[0]?.zone))) invalid('partial_close_utc_required')
    const now = Number(context[0]!.now_msc)
    const validation = evaluatePartialCloseProtection({ plan, parentState: 'pending', history: null, projection: null, now, maxProjectionAgeMs: 1 })
    if (validation.state === 'stopped' || !uuid.test(plan.workflowId)
      || !uuid.test(plan.parentIntentId) || !/^[\x21-\x7e]{1,191}$/.test(plan.parentCommandId)
      || !/^[1-9][0-9]{0,9}$/.test(plan.target.userId) || Number(plan.target.userId) > 2147483647
      || !/^[1-9][0-9]{0,19}$/.test(plan.target.accountId) || BigInt(plan.target.accountId) > 18446744073709551615n) invalid('partial_close_plan_invalid')
    const hash = sha256Canonical(plan)
    if (Buffer.byteLength(JSON.stringify(plan)) > 16384) invalid('partial_close_plan_invalid')
    // Same account-first lock order as command creation and dispatch.
    const [accounts] = await connection.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [plan.target.accountId])
    if (accounts.length !== 1) invalid('partial_close_parent_mismatch')
    // Serialize registration with dispatch on the same intent/command locks.
    const [parents] = await connection.execute<ParentRow[]>(`SELECT i.id intent_id,c.id command_id,c.user_id,c.trading_account_id,
      i.user_id intent_user_id,i.trading_account_id intent_account_id,i.action_kind,i.status intent_status,i.expires_at_utc intent_expires_at,c.deadline_at_utc command_deadline_at,c.status,c.action,
      c.terminal_instance_id,c.broker_server,c.account_login,c.connection_epoch,c.request_sha256,p.request_envelope_json,
      ip.action_json,ip.action_sha256
      FROM execution_intents i INNER JOIN bridge_commands_v4 c ON c.execution_intent_id=i.id
      INNER JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id
      INNER JOIN execution_intent_payloads ip ON ip.execution_intent_id=i.id
      WHERE i.id=? AND c.id=? FOR UPDATE`, [plan.parentIntentId, plan.parentCommandId])
    const parent = parents[0]
    if (parents.length !== 1 || !parent || String(parent.user_id) !== plan.target.userId
      || String(parent.intent_user_id) !== plan.target.userId || String(parent.trading_account_id) !== plan.target.accountId
      || String(parent.intent_account_id) !== plan.target.accountId) invalid('partial_close_parent_mismatch')
    const [existing] = await connection.execute<RegistrationRow[]>(`SELECT id,parent_intent_id,parent_command_id,user_id,trading_account_id,
      plan_json,plan_sha256,status,revision FROM partial_close_workflows_v4
      WHERE id=? OR parent_intent_id=? OR parent_command_id=? FOR UPDATE`, [plan.workflowId, plan.parentIntentId, plan.parentCommandId])
    if (existing.length) {
      const row = existing[0]!, saved = parse(row.plan_json)
      if (existing.length !== 1 || row.id !== plan.workflowId || row.parent_intent_id !== plan.parentIntentId
        || row.parent_command_id !== plan.parentCommandId || String(row.user_id) !== plan.target.userId
        || String(row.trading_account_id) !== plan.target.accountId || row.plan_sha256 !== hash
        || sha256Canonical(saved) !== hash) invalid('partial_close_registration_conflict')
      const [events] = await connection.execute<RowDataPacket[]>(`SELECT event_type,payload_json,payload_sha256
        FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision=1 FOR SHARE`, [plan.workflowId])
      const event = { planHash: hash, parentIntentId: plan.parentIntentId, parentCommandId: plan.parentCommandId }
      if (events.length !== 1 || events[0]!.event_type !== 'registered' || events[0]!.payload_sha256 !== sha256Canonical(event)
        || sha256Canonical(parse(events[0]!.payload_json)) !== sha256Canonical(event)) invalid('partial_close_registration_audit_mismatch')
      return { registration: { plan: structuredClone(saved), planHash: hash, revision: Number(row.revision), status: row.status }, replayed: true }
    }
    if (validation.state !== 'wait_close' || parent.status !== 'queued' || parent.intent_status !== 'prepared'
      || !(parent.intent_expires_at instanceof Date) || parent.intent_expires_at.getTime() <= now
      || !(parent.command_deadline_at instanceof Date) || parent.command_deadline_at.getTime() <= now) invalid('partial_close_registration_too_late')
    const request = parse(parent.request_envelope_json), action = parse(parent.action_json), expected = request.payload.expected_state
    if (parent.action_kind !== 'close_position' || parent.action !== 'position.close'
      || action.kind !== 'close_position' || sha256Canonical(action) !== parent.action_sha256
      || action.parameters.ticket !== plan.target.ticket || !matchVolume(action.parameters.volume, plan.closeVolume)
      || action.expectedState.positionsRevision !== plan.initialRevision
      || canonicalHash(request.payload) !== parent.request_sha256 || request.type !== 'command.request'
      || request.correlation_id !== plan.parentIntentId || request.payload.command_id !== plan.parentCommandId
      || request.payload.action !== 'position.close' || request.payload.params.ticket !== plan.target.ticket
      || !matchVolume(request.payload.params.volume, plan.closeVolume)
      || !Number.isSafeInteger(request.route.connection_epoch) || request.route.connection_epoch < 1
      || request.route.connection_epoch !== Number(parent.connection_epoch)
      || request.route.terminal_instance_id !== plan.target.terminalInstanceId
      || request.route.account_ref.broker_server !== plan.target.brokerServer || request.route.account_ref.login !== plan.target.login
      || parent.terminal_instance_id !== plan.target.terminalInstanceId || parent.broker_server !== plan.target.brokerServer
      || parent.account_login !== plan.target.login || !expected || expected.ticket !== plan.target.ticket
      || expected.symbol !== plan.target.symbol || expected.direction !== plan.target.side
      || !matchVolume(expected.volume, plan.initialVolume)) invalid('partial_close_parent_mismatch')
    const target = await targetReader.read({ target: { ...plan.target }, revision: plan.initialRevision, connectionEpoch: request.route.connection_epoch })
    if (!target || sha256Canonical(target.target) !== sha256Canonical(plan.target) || target.revision !== plan.initialRevision
      || !matchVolume(target.volume, plan.initialVolume)) invalid('partial_close_registration_target_mismatch')
    await connection.execute(`INSERT INTO partial_close_workflows_v4
      (id,parent_intent_id,parent_command_id,user_id,trading_account_id,plan_json,plan_sha256,status,revision,expires_at_utc,created_at_utc,updated_at_utc)
      VALUES (?,?,?,?,?,?,?,'awaiting_close',1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [plan.workflowId,plan.parentIntentId,plan.parentCommandId,plan.target.userId,plan.target.accountId,JSON.stringify(plan),hash,new Date(plan.expiresAt)])
    const event = { planHash: hash, parentIntentId: plan.parentIntentId, parentCommandId: plan.parentCommandId }
    await connection.execute(`INSERT INTO partial_close_workflow_events_v4
      (workflow_id,revision,event_type,payload_json,payload_sha256,occurred_at_utc)
      VALUES (?,1,'registered',?,?,UTC_TIMESTAMP(3))`, [plan.workflowId,JSON.stringify(event),sha256Canonical(event)])
    return { registration: { plan: structuredClone(plan), planHash: hash, revision: 1, status: 'awaiting_close' }, replayed: false }
  } }
}
