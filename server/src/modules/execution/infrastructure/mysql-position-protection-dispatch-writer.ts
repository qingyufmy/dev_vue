import type { PoolConnection } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import type { PositionProtectionCommandReviewer } from '../application/position-protection-command-reviewer.js'
import { readPositionProtectionDispatchReview } from './mysql-position-protection-dispatch-review.js'
import { sha256Canonical } from '../domain/execution.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

/** Dispatch transition owns the transaction; failure at any later write must roll this receipt back too. */
export async function writePositionProtectionDispatchReview(connection: PoolConnection, command: BridgeCommand,
  workflowId: string, reviewer: PositionProtectionCommandReviewer): Promise<string> {
  const review = await readPositionProtectionDispatchReview(connection, command, workflowId, reviewer)
  await connection.execute(`INSERT INTO position_protection_dispatches_v4
    (bridge_command_id,command_revision,review_json,review_sha256,checked_at_utc) VALUES (?,2,?,?,?)`,
  [command.id, JSON.stringify(review), sha256Canonical(review), bridgeCommandSqlTime(review.checkedAt)])
  return review.checkedAt
}

export type CapturePositionProtectionDispatch = (command: BridgeCommand) => Promise<
  (connection: PoolConnection, command: BridgeCommand, workflowId: string) => Promise<string>>
