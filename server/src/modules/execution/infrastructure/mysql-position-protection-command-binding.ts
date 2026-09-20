import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import type { PositionProtectionCommandReview } from '../domain/position-protection-command-review.js'
import type { PositionProtectionChild } from '../domain/position-protection-child.js'
import { bindPositionProtectionCommand } from '../domain/position-protection-command-binding.js'
import { sha256Canonical } from '../domain/execution.js'
import { readPositionProtectionPreparation } from './mysql-position-protection-preparation.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
function fail(code: string): never { throw new BridgeCommandError(`position_protection_binding_${code}`,409) }

/** Command creation owns the transaction. Invoke after its command/payload INSERT, before its event/outbox. */
export async function writePositionProtectionCommandBinding(db: PoolConnection, command: BridgeCommand, authority: PositionProtectionCommandReview): Promise<void> {
  const scope = {workflowId:authority.workflowId,userId:command.userId,accountId:command.accountId}
  const prepared = await readPositionProtectionPreparation(db,scope)
  if (prepared.childIntentId !== command.executionIntentId || !['protecting', 'succeeded', 'stopped'].includes(prepared.status)) fail('source_mismatch')
  const [sources] = await db.execute<RowDataPacket[]>('SELECT child_json FROM position_protection_reviews_v4 WHERE workflow_id=? AND child_intent_id=? FOR SHARE',[scope.workflowId,command.executionIntentId])
  if (sources.length !== 1 || !sources[0]!.child_json) fail('source_missing')
  const child = parse<PositionProtectionChild>(sources[0]!.child_json)
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT c.execution_intent_id,c.user_id,CAST(c.trading_account_id AS CHAR) account_id,c.status,c.request_sha256,p.request_envelope_json
    FROM bridge_commands_v4 c JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id WHERE c.id=? FOR SHARE`,[command.id])
  const row = rows[0]
  if (rows.length !== 1 || !row || row.execution_intent_id !== command.executionIntentId || row.user_id !== command.userId || row.account_id !== command.accountId
    || row.request_sha256 !== command.requestHash || sha256Canonical(parse(row.request_envelope_json)) !== sha256Canonical(command.request)) fail('command_mismatch')
  const [existing] = await db.execute<RowDataPacket[]>('SELECT binding_json,binding_sha256,authority_sha256,command_sha256,UNIX_TIMESTAMP(created_at_utc)*1000 bound_msc FROM position_protection_commands_v4 WHERE bridge_command_id=? FOR SHARE',[command.id])
  if (existing.length) {
    const stored = existing[0]!, at = Number(stored.bound_msc)
    if (!Number.isSafeInteger(at) || at < 1) fail('clock_invalid')
    const binding = bindPositionProtectionCommand(child,authority,command,new Date(at))
    if (sha256Canonical(binding) !== stored.binding_sha256 || sha256Canonical(parse(stored.binding_json)) !== stored.binding_sha256
      || binding.authorityHash !== stored.authority_sha256 || binding.commandHash !== stored.command_sha256) fail('conflict')
    return
  }
  const [parents] = await db.execute<RowDataPacket[]>(`SELECT i.status,p.status parent_status,c.status parent_command_status FROM execution_intents i
    JOIN partial_close_workflows_v4 w ON w.id=i.position_workflow_id JOIN execution_intents p ON p.id=w.parent_intent_id
    JOIN bridge_commands_v4 c ON c.id=w.parent_command_id WHERE i.id=? FOR SHARE`,[command.executionIntentId])
  if (prepared.status !== 'protecting' || row.status !== 'queued' || parents.length !== 1 || parents[0]!.status !== 'prepared'
    || parents[0]!.parent_status !== 'succeeded' || parents[0]!.parent_command_status !== 'succeeded') fail('state_invalid')
  const [snapshots] = await db.execute<RowDataPacket[]>(`SELECT state_json,state_sha256,projection_revision FROM bridge_trade_state_snapshots_v4
    WHERE trading_account_id=? AND entity_kind='position' AND ticket=? AND terminal_instance_id=? AND connection_epoch=? FOR SHARE`,
  [command.accountId,child.request.target.ticket,command.route.terminalInstanceId,command.route.connectionEpoch])
  const snapshot = snapshots[0]
  if (snapshots.length !== 1 || !snapshot || Number(snapshot.projection_revision) !== authority.action.expectedState.positionsRevision
    || sha256Canonical(parse(snapshot.state_json)) !== snapshot.state_sha256
    || snapshot.state_sha256 !== sha256Canonical(command.request.payload.expected_state)) fail('snapshot_mismatch')
  const [clock] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const at = Number(clock[0]?.now_msc)
  if (!['+00:00','UTC'].includes(String(clock[0]?.zone)) || !Number.isSafeInteger(at)) fail('clock_invalid')
  const now = new Date(at), binding = bindPositionProtectionCommand(child,authority,command,now), payload = JSON.stringify(binding)
  if (Buffer.byteLength(payload) > 1024*1024) fail('payload_too_large')
  await db.execute(`INSERT INTO position_protection_commands_v4
    (bridge_command_id,child_intent_id,workflow_id,binding_json,binding_sha256,authority_sha256,command_sha256,created_at_utc)
    VALUES (?,?,?,?,?,?,?,?)`,[binding.bridgeCommandId,binding.childIntentId,binding.workflowId,payload,sha256Canonical(binding),binding.authorityHash,binding.commandHash,bridgeCommandSqlTime(now.toISOString())])
}

export async function replayPositionProtectionCommandBinding(db: PoolConnection, command: BridgeCommand, workflowId: string): Promise<void> {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT binding_json FROM position_protection_commands_v4 WHERE bridge_command_id=? AND child_intent_id=? AND workflow_id=? FOR SHARE',
    [command.id,command.executionIntentId,workflowId])
  if (rows.length !== 1) fail('missing')
  const binding = parse<{ authority: PositionProtectionCommandReview }>(rows[0]!.binding_json)
  if (binding.authority?.workflowId !== workflowId) fail('source_mismatch')
  await writePositionProtectionCommandBinding(db,command,binding.authority)
}
