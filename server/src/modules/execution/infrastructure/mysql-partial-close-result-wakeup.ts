import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import { BridgeCommandError } from '../domain/bridge-command.js'

/** Result persistence owns the transaction and account lock. A wakeup does not prove the close volume. */
export async function wakePartialCloseResult(db: PoolConnection, command: BridgeCommand) {
  if (command.action !== 'position.close') return
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT id,parent_intent_id,user_id,
    CAST(trading_account_id AS CHAR) account_id,status FROM partial_close_workflows_v4
    WHERE parent_command_id=? FOR UPDATE`, [command.id])
  if (rows.length === 0) return
  const workflow = rows[0]
  if (rows.length !== 1 || !workflow || workflow.parent_intent_id !== command.executionIntentId
    || workflow.user_id !== command.userId || workflow.account_id !== command.accountId) {
    throw new BridgeCommandError('partial_close_result_scope_invalid', 409)
  }
  if (['succeeded', 'stopped', 'expired'].includes(workflow.status)) return
  if (!['awaiting_close', 'risk_review_required', 'protecting'].includes(workflow.status)) {
    throw new BridgeCommandError('partial_close_result_state_invalid', 409)
  }
  await db.execute(`INSERT INTO outbox_events
    (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'partial_close_workflow',?,'execution.partial-close.requested',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
  [randomUUID(), workflow.id, JSON.stringify({ workflow_id: workflow.id, user_id: workflow.user_id, trading_account_id: workflow.account_id })])
}
