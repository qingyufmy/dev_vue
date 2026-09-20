import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import { BridgeCommandError } from '../domain/bridge-command.js'

/** Called under the command result transaction's account lock; this only schedules business evaluation. */
export async function wakePositionProtectionResult(db: PoolConnection, command: BridgeCommand, workflowId: string) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT w.id,w.user_id,CAST(w.trading_account_id AS CHAR) account_id,w.status,w.revision
    FROM position_protection_commands_v4 b JOIN partial_close_workflows_v4 w ON w.id=b.workflow_id
    WHERE b.bridge_command_id=? AND b.child_intent_id=? AND w.id=? AND w.user_id=? AND w.trading_account_id=? FOR UPDATE`,
  [command.id, command.executionIntentId, workflowId, command.userId, command.accountId])
  const workflow = rows[0]
  if (command.action !== 'position.protection.set' || rows.length !== 1 || !workflow) {
    throw new BridgeCommandError('position_protection_result_scope_invalid', 409)
  }
  if (['succeeded', 'stopped'].includes(workflow.status) && Number(workflow.revision) === 4) return
  if (workflow.status !== 'protecting' || Number(workflow.revision) !== 3) {
    throw new BridgeCommandError('position_protection_result_workflow_invalid', 409)
  }
  await db.execute(`INSERT INTO outbox_events
    (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'partial_close_workflow',?,'execution.partial-close.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
  [randomUUID(), workflow.id, JSON.stringify({ workflow_id: workflow.id, user_id: workflow.user_id, trading_account_id: workflow.account_id })])
}
