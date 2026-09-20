import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import type { PositionProtectionCommandBinding } from '../domain/position-protection-command-binding.js'
import type { PositionProtectionChild } from '../domain/position-protection-child.js'
import type { PositionProtectionCommandReviewer } from '../application/position-protection-command-reviewer.js'
import { reviewPositionProtectionDispatch } from '../domain/position-protection-dispatch-review.js'
import { replayPositionProtectionCommandBinding } from './mysql-position-protection-command-binding.js'
import { sha256Canonical } from '../domain/execution.js'

const parse = <T>(input: string | T): T => typeof input === 'string' ? JSON.parse(input) as T : input
function fail(): never { throw new BridgeCommandError('position_protection_dispatch_snapshot_invalid', 409) }

/** Caller owns account/command/intent locks and must persist this review with the dispatch transition. */
export async function readPositionProtectionDispatchReview(db: PoolConnection, command: BridgeCommand,
  workflowId: string, reviewer: PositionProtectionCommandReviewer) {
  await replayPositionProtectionCommandBinding(db, command, workflowId)
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT b.binding_json,UNIX_TIMESTAMP(b.created_at_utc)*1000 bound_msc,r.child_json
    FROM position_protection_commands_v4 b JOIN position_protection_reviews_v4 r
      ON r.workflow_id=b.workflow_id AND r.child_intent_id=b.child_intent_id
    WHERE b.bridge_command_id=? AND b.workflow_id=? AND b.child_intent_id=? FOR SHARE`,
  [command.id, workflowId, command.executionIntentId])
  if (rows.length !== 1) fail()
  const row = rows[0]!, bound = Number(row.bound_msc)
  if (!Number.isSafeInteger(bound) || bound < 1) fail()
  const current = await reviewer.review({ workflowId, userId: command.userId, accountId: command.accountId }, command.executionIntentId)
  const ticket = command.request.payload.params.ticket
  if (typeof ticket !== 'string') fail()
  const [snapshots] = await db.execute<RowDataPacket[]>(`SELECT state_json,state_sha256,projection_revision
    FROM bridge_trade_state_snapshots_v4 WHERE trading_account_id=? AND entity_kind='position' AND ticket=?
      AND terminal_instance_id=? AND connection_epoch=? FOR SHARE`,
  [command.accountId, ticket, command.route.terminalInstanceId, command.route.connectionEpoch])
  const snapshot = snapshots[0]
  if (snapshots.length !== 1 || !snapshot || Number(snapshot.projection_revision) !== current.action.expectedState.positionsRevision
    || sha256Canonical(parse(snapshot.state_json)) !== snapshot.state_sha256
    || sha256Canonical(command.request.payload.expected_state) !== snapshot.state_sha256) fail()
  const [clock] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const at = Number(clock[0]?.now_msc)
  if (!['+00:00', 'UTC'].includes(String(clock[0]?.zone)) || !Number.isSafeInteger(at)) fail()
  return reviewPositionProtectionDispatch(parse<PositionProtectionChild>(row.child_json), command,
    parse<PositionProtectionCommandBinding>(row.binding_json), new Date(bound), current, new Date(at))
}
