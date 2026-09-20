import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { PositionProtectionReviewPort } from '../application/position-protection-preparation.js'
import type { PositionProtectionCommandReviewer } from '../application/position-protection-command-reviewer.js'
import type { PositionProtectionChild } from '../domain/position-protection-child.js'
import { reviewPositionProtectionCommand } from '../domain/position-protection-command-review.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { readPositionProtectionPreparation } from './mysql-position-protection-preparation.js'

/** Caller owns the transaction. All source validation, current review and clock reads retain its locks. */
export function createMysqlPositionProtectionCommandReviewer(db: PoolConnection, current: PositionProtectionReviewPort,
  clock: { now(): Promise<Date> }): PositionProtectionCommandReviewer {
  return { async review(input,childIntentId) {
    const scope = structuredClone(input)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(childIntentId)) throw new BridgeCommandError('position_protection_child_invalid',409)
    const saved = await readPositionProtectionPreparation(db,scope)
    if (saved.status !== 'protecting' || saved.childIntentId !== childIntentId) throw new BridgeCommandError('position_protection_child_mismatch',409)
    const [intents] = await db.execute<RowDataPacket[]>(`SELECT i.status,p.status parent_status,c.status parent_command_status
      FROM execution_intents i JOIN partial_close_workflows_v4 w ON w.id=i.position_workflow_id
      JOIN execution_intents p ON p.id=w.parent_intent_id JOIN bridge_commands_v4 c ON c.id=w.parent_command_id
      WHERE i.id=? FOR UPDATE`,[childIntentId])
    if (intents.length !== 1 || intents[0]!.status !== 'prepared') throw new BridgeCommandError('position_protection_child_not_prepared',409)
    if (intents[0]!.parent_status !== 'succeeded' || intents[0]!.parent_command_status !== 'succeeded') throw new BridgeCommandError('position_protection_parent_not_confirmed',409)
    const [receipts] = await db.execute<RowDataPacket[]>('SELECT child_json FROM position_protection_reviews_v4 WHERE workflow_id=? AND child_intent_id=? FOR SHARE',[scope.workflowId,childIntentId])
    if (receipts.length !== 1 || !receipts[0]!.child_json) throw new BridgeCommandError('position_protection_receipt_missing',409)
    const child = (typeof receipts[0]!.child_json === 'string' ? JSON.parse(receipts[0]!.child_json) : receipts[0]!.child_json) as PositionProtectionChild
    const review = await current.review(structuredClone(child.request))
    return reviewPositionProtectionCommand(child,review,await clock.now())
  } }
}
