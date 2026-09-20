import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { BridgeCommand } from '../domain/bridge-command.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import type { ExecutionAction } from '../domain/execution-input.js'
import type { PartialCloseRegistrationTargetReader } from '../application/partial-close-workflow-store.js'
import { bindPartialCloseDispatchReview, partialCloseDispatchRiskRequest, type PartialCloseDispatchRiskReview } from '../domain/partial-close-dispatch-review.js'
import { readPartialCloseParentDispatch } from './mysql-partial-close-parent-dispatch.js'
import { sha256Canonical } from '../domain/execution.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

export interface PartialCloseParentDispatchReviewer {
  review(request: ReturnType<typeof partialCloseDispatchRiskRequest>): Promise<PartialCloseDispatchRiskReview>
}

/** Capture external route facts before opening the dispatch transaction. */
export type CapturePartialCloseParentDispatch = (command: BridgeCommand) => Promise<
  (connection: PoolConnection, command: BridgeCommand, action: ExecutionAction, intentExpiresAt: number) => Promise<string>>

/** Caller must retain the account/intent/command locks and commit the dispatch transition with this receipt. */
export async function writePartialCloseParentDispatchReview(db: PoolConnection, command: BridgeCommand, action: ExecutionAction,
  intentExpiresAt: number, targets: PartialCloseRegistrationTargetReader, reviewer: PartialCloseParentDispatchReviewer) {
  const { plan } = await readPartialCloseParentDispatch(db,command,action,intentExpiresAt,targets)
  const review = await reviewer.review(partialCloseDispatchRiskRequest(plan,command))
  const [rows] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const at = Number(rows[0]?.now_msc)
  if (!['+00:00','UTC'].includes(String(rows[0]?.zone)) || !Number.isSafeInteger(at)) throw new BridgeCommandError('partial_close_dispatch_clock_invalid',409)
  const receipt = bindPartialCloseDispatchReview(plan,command,review,new Date(at))
  const [inserted] = await db.execute<ResultSetHeader>(`INSERT INTO partial_close_parent_dispatches_v4
    (parent_command_id,command_revision,review_json,review_sha256,checked_at_utc) VALUES (?,2,?,?,?)`,
  [command.id,JSON.stringify(receipt),sha256Canonical(receipt),bridgeCommandSqlTime(receipt.checkedAt)])
  if (inserted.affectedRows !== 1) throw new BridgeCommandError('partial_close_dispatch_receipt_unconfirmed',409)
  return receipt.checkedAt
}
