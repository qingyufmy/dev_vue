import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { readUnissuedPositionProtectionExpiry } from './mysql-position-protection-unissued-expiry.js'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { evaluatePositionProtectionOutcome } from '../domain/position-protection-outcome.js'
import { sha256Canonical } from '../domain/execution.js'

type Evidence = Parameters<typeof evaluatePositionProtectionOutcome>[0]
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
function fail(): never { throw new BridgeCommandError('position_protection_outcome_corrupt', 409) }

/** Replays frozen evidence, not today's positions. Caller verifies scope ownership before calling. */
export async function readPositionProtectionOutcomeReceipt(db: PoolConnection, scope: PartialCloseWorkflowScope) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT r.*,w.status workflow_status,w.revision,w.user_id,CAST(w.trading_account_id AS CHAR) account_id,
    p.child_sha256 FROM position_protection_outcomes_v4 r JOIN partial_close_workflows_v4 w ON w.id=r.workflow_id
    JOIN position_protection_reviews_v4 p ON p.workflow_id=r.workflow_id AND p.child_intent_id=r.child_intent_id WHERE r.workflow_id=? FOR SHARE`, [scope.workflowId])
  if (!rows.length) return readUnissuedPositionProtectionExpiry(db, scope)
  const row = rows[0]!, evidence = parse<Evidence>(row.evidence_json)
  if (rows.length !== 1 || row.user_id !== scope.userId || row.account_id !== scope.accountId || Number(row.revision) !== 4
    || sha256Canonical(evidence) !== row.evidence_sha256 || sha256Canonical(evidence.child) !== row.child_sha256
    || evidence.child.request.workflowId !== scope.workflowId || evidence.child.request.userId !== scope.userId || evidence.child.request.accountId !== scope.accountId
    || evidence.child.intent.id !== row.child_intent_id || evidence.command.id !== row.bridge_command_id) fail()
  const outcome = evaluatePositionProtectionOutcome(evidence)
  if (!['succeeded', 'stopped'].includes(outcome.state) || row.status !== outcome.state || row.workflow_status !== outcome.state) fail()
  const event = { outcomeHash: row.evidence_sha256, childIntentId: row.child_intent_id, commandId: row.bridge_command_id, outcome }
  const [events] = await db.execute<RowDataPacket[]>('SELECT event_type,payload_json,payload_sha256 FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision=4 FOR SHARE', [scope.workflowId])
  if (events.length !== 1 || events[0]!.event_type !== outcome.state || events[0]!.payload_sha256 !== sha256Canonical(event)
    || sha256Canonical(parse(events[0]!.payload_json)) !== events[0]!.payload_sha256) fail()
  return { outcome, revision: 4 }
}
