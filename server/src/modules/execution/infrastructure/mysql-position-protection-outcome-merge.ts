import { readPositionProtectionOutcomeReceipt } from './mysql-position-protection-outcome-receipt.js'
import { expireUnissuedPositionProtection } from './mysql-position-protection-unissued-expiry.js'
import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import type { PositionProtectionChild } from '../domain/position-protection-child.js'
import { BridgeCommandError, bridgeCommandId, type BridgeCommand } from '../domain/bridge-command.js'
import { evaluatePositionProtectionOutcome, type PositionProtectionOutcomeProjection } from '../domain/position-protection-outcome.js'
import { sha256Canonical } from '../domain/execution.js'
import { readPositionProtectionPreparation } from './mysql-position-protection-preparation.js'
import { readStoredBridgeCommand } from './mysql-bridge-command-repository.js'
import { readPositionProtectionSuccessReceipt } from './mysql-position-protection-success-receipt.js'
import { bridgeCommandSqlTime } from './bridge-command-sql-time.js'

type Evidence = Parameters<typeof evaluatePositionProtectionOutcome>[0]
export type PositionProtectionOutcomeProjectionReader = (db: PoolConnection, child: PositionProtectionChild, command: BridgeCommand) => Promise<PositionProtectionOutcomeProjection | null>
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
function fail(): never { throw new BridgeCommandError('position_protection_outcome_corrupt', 409) }

/** Caller owns BEGIN/COMMIT. Account locking serializes this with command/result writers. */
export async function mergePositionProtectionOutcome(db: PoolConnection, scope: PartialCloseWorkflowScope,
  readProjection: PositionProtectionOutcomeProjectionReader, maxProjectionAgeMs: number) {
  const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [scope.accountId])
  const [owners] = await db.execute<RowDataPacket[]>(`SELECT trading_account_id FROM trading_account_ownerships
    WHERE trading_account_id=? AND user_id=? AND role='owner' AND revoked_at_utc IS NULL FOR SHARE`, [scope.accountId, scope.userId])
  if (accounts.length !== 1 || owners.length !== 1) fail()
  const replay = await readPositionProtectionOutcomeReceipt(db, scope)
  if (replay) return { ...replay, replayed: true }
  const prepared = await readPositionProtectionPreparation(db, scope)
  if (prepared.status !== 'protecting' || !prepared.childIntentId) fail()
  const [rows] = await db.execute<RowDataPacket[]>('SELECT child_json,child_sha256 FROM position_protection_reviews_v4 WHERE workflow_id=? FOR SHARE', [scope.workflowId])
  const child = parse<PositionProtectionChild>(rows[0]?.child_json)
  if (!child || sha256Canonical(child) !== rows[0]?.child_sha256) fail()
  await db.execute('SELECT id FROM execution_intents WHERE id=? FOR UPDATE', [child.intent.id])
  const commandId = bridgeCommandId(child.intent.id, 1)
  await db.execute('SELECT id FROM bridge_commands_v4 WHERE id=? FOR UPDATE', [commandId])
  const command = await readStoredBridgeCommand(db, commandId)
  if (!command) return expireUnissuedPositionProtection(db, child)
  const receipt = await readPositionProtectionSuccessReceipt(db, command)
  let dispatchedPositionRevision: number | null = null
  if (receipt) {
    const [dispatches] = await db.execute<RowDataPacket[]>('SELECT review_json,review_sha256 FROM position_protection_dispatches_v4 WHERE bridge_command_id=? FOR SHARE', [commandId])
    const dispatch = parse<{ commandId: string; commandHash: string; authority: { action: { expectedState: { positionsRevision: number } } } }>(dispatches[0]?.review_json)
    if (dispatches.length !== 1 || !dispatch || sha256Canonical(dispatch) !== dispatches[0]?.review_sha256
      || dispatch.commandId !== command.id || dispatch.commandHash !== command.requestHash) fail()
    dispatchedPositionRevision = dispatch.authority.action.expectedState.positionsRevision
  }
  const projection = receipt ? await readProjection(db, child, command) : null
  const [clock] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const now = Number(clock[0]?.now_msc)
  if (!['+00:00', 'UTC'].includes(String(clock[0]?.zone)) || !Number.isSafeInteger(now)) fail()
  const evidence: Evidence = { child, command, receipt, projection, dispatchedPositionRevision, now, maxProjectionAgeMs }
  const outcome = evaluatePositionProtectionOutcome(evidence)
  if (outcome.state === 'waiting' || outcome.state === 'reconcile') return { outcome, revision: 3, replayed: false }
  const json = JSON.stringify(evidence), hash = sha256Canonical(evidence), at = bridgeCommandSqlTime(new Date(now).toISOString())
  if (Buffer.byteLength(json) > 1024 * 1024) fail()
  await db.execute(`INSERT INTO position_protection_outcomes_v4
    (workflow_id,child_intent_id,bridge_command_id,status,evidence_json,evidence_sha256,created_at_utc) VALUES (?,?,?,?,?,?,?)`,
  [scope.workflowId, child.intent.id, command.id, outcome.state, json, hash, at])
  const [updated] = await db.execute<ResultSetHeader>(`UPDATE partial_close_workflows_v4 SET status=?,revision=4,updated_at_utc=?
    WHERE id=? AND status='protecting' AND revision=3`, [outcome.state, at, scope.workflowId])
  if (updated.affectedRows !== 1) fail()
  const event = { outcomeHash: hash, childIntentId: child.intent.id, commandId: command.id, outcome }
  await db.execute('INSERT INTO partial_close_workflow_events_v4 VALUES (?,4,?,?,?,?)', [scope.workflowId, outcome.state, JSON.stringify(event), sha256Canonical(event), at])
  await db.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'partial_close_workflow',?,'execution.partial-close.progressed',?,'pending',0,?,?)`,
  [randomUUID(), scope.workflowId, JSON.stringify({ workflow_id: scope.workflowId, user_id: scope.userId, trading_account_id: scope.accountId, revision: 4 }), at, at])
  return { outcome, revision: 4, replayed: false }
}
