import { randomUUID } from 'node:crypto'
import { readPositionProtectionOutcomeReceipt } from './mysql-position-protection-outcome-receipt.js'
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PartialCloseWorkflowScope } from '../application/partial-close-workflow-progress.js'
import type { PositionProtectionPreparation, PositionProtectionPreparationResult, PositionProtectionReviewPort } from '../application/position-protection-preparation.js'
import { positionProtectionRequest, preparePositionProtectionChild, type PositionProtectionChild, type PositionProtectionReview } from '../domain/position-protection-child.js'
import type { PartialCloseProtectionPlan, ProtectionEligibility } from '../domain/partial-close-protection.js'
import { sha256Canonical } from '../domain/execution.js'
import { BridgeCommandError } from '../domain/bridge-command.js'
import { bridgeCommandTransaction } from './bridge-command-transaction.js'
import { insertPositionProtectionChild } from './mysql-position-protection-child-writer.js'
import { assertPositionProtectionNotPrepared, expirePositionProtection, verifyPositionProtectionExpiry } from './mysql-position-protection-expiry.js'

const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value
function fail(code: string): never { throw new BridgeCommandError(`position_protection_${code}`, 409) }
export type CapturePositionProtectionReviewer = (scope: PartialCloseWorkflowScope) => Promise<(db: PoolConnection) => PositionProtectionReviewPort>

/** Capture a route before BEGIN. All returned reviewer reads must retain locks on this connection. */
export function createMysqlPositionProtectionPreparation(pool: Pool, capture: CapturePositionProtectionReviewer): PositionProtectionPreparation {
  return { async prepare(input) {
    const scope = structuredClone(input)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.workflowId)
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
      || !/^[1-9][0-9]{0,19}$/.test(scope.accountId) || BigInt(scope.accountId) > 18446744073709551615n) fail('scope_invalid')
    const reviewer = await capture(structuredClone(scope))
    return bridgeCommandTransaction(pool, db => prepare(db, scope, reviewer(db)))
  } }
}

/** Same-transaction replay only: progress-message redelivery may inspect a receipt, but never cause a new review. */
export function readPositionProtectionPreparation(db: PoolConnection, scope: PartialCloseWorkflowScope): Promise<PositionProtectionPreparationResult> {
  return prepare(db,scope,{ async review() { return fail('receipt_missing') } },true)
}

async function prepare(db: PoolConnection, scope: PartialCloseWorkflowScope, reviewer: PositionProtectionReviewPort, replayOnly = false): Promise<PositionProtectionPreparationResult> {
  await utcNow(db)
  const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM trading_accounts WHERE id=? FOR UPDATE', [scope.accountId])
  const [owners] = await db.execute<RowDataPacket[]>(`SELECT trading_account_id FROM trading_account_ownerships
    WHERE trading_account_id=? AND user_id=? AND role='owner' AND revoked_at_utc IS NULL FOR SHARE`, [scope.accountId,scope.userId])
  if (accounts.length !== 1 || owners.length !== 1) fail('scope_unavailable')
  const [locators] = await db.execute<RowDataPacket[]>('SELECT parent_intent_id,parent_command_id FROM partial_close_workflows_v4 WHERE id=? AND user_id=? AND trading_account_id=?', [scope.workflowId,scope.userId,scope.accountId])
  if (locators.length !== 1) fail('workflow_not_found')
  const locator = locators[0]!
  const [parents] = await db.execute<RowDataPacket[]>('SELECT id,operation_id,user_id,trading_account_id,action_kind,status FROM execution_intents WHERE id=? FOR UPDATE', [locator.parent_intent_id])
  const [commands] = await db.execute<RowDataPacket[]>('SELECT id,execution_intent_id,user_id,trading_account_id,action,status FROM bridge_commands_v4 WHERE id=? FOR UPDATE', [locator.parent_command_id])
  const [workflows] = await db.execute<RowDataPacket[]>('SELECT id,parent_intent_id,parent_command_id,user_id,trading_account_id,plan_json,plan_sha256,status,revision FROM partial_close_workflows_v4 WHERE id=? FOR UPDATE', [scope.workflowId])
  const row = workflows[0], parent = parents[0], command = commands[0]
  if (!row || !parent || !command || row.parent_intent_id !== parent.id || row.parent_command_id !== command.id
    || command.execution_intent_id !== parent.id || parent.action_kind !== 'close_position' || command.action !== 'position.close'
    || [row,parent,command].some(value => value.user_id !== scope.userId || String(value.trading_account_id) !== scope.accountId)) fail('parent_mismatch')
  const plan = parse<PartialCloseProtectionPlan>(row.plan_json)
  if (sha256Canonical(plan) !== row.plan_sha256 || plan.workflowId !== row.id || plan.parentIntentId !== parent.id || plan.parentCommandId !== command.id
    || plan.target.userId !== String(scope.userId) || plan.target.accountId !== scope.accountId) fail('plan_corrupt')
  const [events] = await db.execute<RowDataPacket[]>('SELECT revision,event_type,payload_json,payload_sha256 FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision IN (1,2,3) ORDER BY revision FOR SHARE', [row.id])
  const registered = { planHash: row.plan_sha256, parentIntentId: parent.id, parentCommandId: command.id }
  if (events.length < 2 || events.some(event => sha256Canonical(parse(event.payload_json)) !== event.payload_sha256)
    || Number(events[0]!.revision) !== 1 || events[0]!.event_type !== 'registered' || events[0]!.payload_sha256 !== sha256Canonical(registered)
    || Number(events[1]!.revision) !== 2 || events[1]!.event_type !== 'risk_review_required') fail('audit_corrupt')
  const readyEvent = parse<{ planHash: string; assessment: ProtectionEligibility }>(events[1]!.payload_json)
  if (readyEvent.planHash !== row.plan_sha256 || readyEvent.assessment.state !== 'risk_review_required') fail('eligibility_corrupt')
  const request = positionProtectionRequest(plan, readyEvent.assessment, 2)
  const [receipts] = await db.execute<RowDataPacket[]>('SELECT * FROM position_protection_reviews_v4 WHERE workflow_id=? FOR SHARE', [row.id])
  if (receipts.length) {
    const receipt = receipts[0]!, review = parse<PositionProtectionReview>(receipt.review_json)
    if (receipt.request_sha256 !== sha256Canonical(request) || sha256Canonical(parse(receipt.request_json)) !== receipt.request_sha256
      || sha256Canonical(review) !== receipt.review_sha256 || review.requestHash !== receipt.request_sha256
      || Number(receipt.workflow_revision) !== 2 || review.workflowId !== row.id || review.workflowRevision !== 2 || receipt.status !== review.evaluation.status) fail('receipt_corrupt')
    const child = receipt.child_json === null ? null : parse<PositionProtectionChild>(receipt.child_json)
    if (child) {
      if (receipt.status !== 'approved' || receipt.child_intent_id !== child.intent.id || receipt.child_sha256 !== sha256Canonical(child)
        || child.reviewHash !== receipt.review_sha256 || sha256Canonical(child.request) !== receipt.request_sha256
        || sha256Canonical(child.review) !== receipt.review_sha256) fail('receipt_corrupt')
      const rebuilt = preparePositionProtectionChild({plan,ready:readyEvent.assessment,revision:2,parentOperationId:parent.operation_id,review,now:new Date(child.intent.createdAt)})
      if (sha256Canonical(rebuilt) !== receipt.child_sha256) fail('receipt_corrupt')
      await verifyChild(db,child)
    } else if (receipt.status !== 'rejected' || receipt.child_intent_id !== null || receipt.child_sha256 !== null) fail('receipt_corrupt')
    const status = child ? 'protecting' : 'stopped'
    const event = { planHash: row.plan_sha256, requestHash: receipt.request_sha256, reviewHash: receipt.review_sha256,
      childIntentId: receipt.child_intent_id, rejectCode: review.evaluation.rejectCode }
    if (events.length !== 3 || events[2]!.event_type !== status
      || Number(events[2]!.revision) !== 3 || events[2]!.payload_sha256 !== sha256Canonical(event)) fail('state_corrupt')
    if (child && Number(row.revision) === 4) {
      const terminal = await readPositionProtectionOutcomeReceipt(db, scope)
      if (!terminal || (terminal.outcome.state !== 'succeeded' && terminal.outcome.state !== 'stopped')) fail('state_corrupt')
      return { workflowId: row.id, revision: 4, status: terminal.outcome.state, childIntentId: child.intent.id,
        rejectCode: terminal.outcome.state === 'stopped' ? terminal.outcome.reason : null, replayed: true }
    }
    if (Number(row.revision) !== 3 || row.status !== status) fail('state_corrupt')
    return { workflowId: row.id, revision: 3, status, childIntentId: receipt.child_intent_id, rejectCode: review.evaluation.rejectCode, replayed: true }
  }
  if (row.status === 'expired' && Number(row.revision) === 3) {
    if (events.length !== 3) fail('expiry_corrupt')
    verifyPositionProtectionExpiry(events[2],row.plan_sha256,sha256Canonical(request),plan.expiresAt,await utcNow(db))
    await assertPositionProtectionNotPrepared(db,row.id)
    return {workflowId:row.id,revision:3,status:'expired',childIntentId:null,rejectCode:null,replayed:true}
  }
  if (replayOnly) fail('receipt_missing')
  if (row.status !== 'risk_review_required' || Number(row.revision) !== 2 || events.length !== 2) fail('state_invalid')
  if (parent.status !== 'succeeded' || command.status !== 'succeeded') fail('parent_not_confirmed')
  const beforeReview = await utcNow(db)
  if (beforeReview.getTime() >= plan.expiresAt) return expirePositionProtection(db,scope,row.plan_sha256,sha256Canonical(request),plan.expiresAt,beforeReview)
  const review = structuredClone(await reviewer.review(structuredClone(request)))
  const now = await utcNow(db)
  if (now.getTime() >= plan.expiresAt) return expirePositionProtection(db,scope,row.plan_sha256,sha256Canonical(request),plan.expiresAt,now)
  if (review.workflowId !== row.id || review.workflowRevision !== 2 || review.requestHash !== sha256Canonical(request)
    || !/^[0-9a-f]{64}$/.test(review.contextHash) || !/^[0-9a-f]{64}$/.test(review.evaluation.policyHash)
    || review.evaluation.manualReleaseId !== null || review.evaluation.manualReleaseRevision !== null
    || !Number.isSafeInteger(Date.parse(review.evaluation.evaluatedAt)) || new Date(review.evaluation.evaluatedAt).toISOString() !== review.evaluation.evaluatedAt
    || Date.parse(review.evaluation.evaluatedAt) > now.getTime() || Date.parse(review.evaluation.evaluatedAt) < request.notBefore) fail('review_mismatch')
  let child: PositionProtectionChild | null = null
  if (review.evaluation.status === 'approved') child = preparePositionProtectionChild({plan,ready:readyEvent.assessment,revision:2,parentOperationId:parent.operation_id,review,now})
  else if (review.evaluation.status !== 'rejected' || !review.evaluation.rejectCode || review.evaluation.approvedActions.length !== 0) fail('review_mismatch')
  const reviewHash = sha256Canonical(review), status = child ? 'protecting' : 'stopped'
  const event = {planHash:row.plan_sha256,requestHash:review.requestHash,reviewHash,childIntentId:child?.intent.id ?? null,rejectCode:review.evaluation.rejectCode}
  const requestJson = JSON.stringify(request), reviewJson = JSON.stringify(review), childJson = child ? JSON.stringify(child) : null
  if (Buffer.byteLength(requestJson)+Buffer.byteLength(reviewJson)+Buffer.byteLength(childJson ?? '') > 1024*1024) fail('evidence_too_large')
  if (child) await insertPositionProtectionChild(db,child)
  await db.execute(`INSERT INTO position_protection_reviews_v4
    (workflow_id,workflow_revision,request_json,request_sha256,review_json,review_sha256,status,child_intent_id,child_json,child_sha256,created_at_utc)
    VALUES (?,2,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
  [row.id,requestJson,review.requestHash,reviewJson,reviewHash,review.evaluation.status,child?.intent.id ?? null,childJson,child ? sha256Canonical(child) : null])
  const [updated] = await db.execute<ResultSetHeader>(`UPDATE partial_close_workflows_v4 SET status=?,revision=3,updated_at_utc=UTC_TIMESTAMP(3)
    WHERE id=? AND revision=2 AND status='risk_review_required'`, [status,row.id])
  if (updated.affectedRows !== 1) fail('revision_conflict')
  await db.execute(`INSERT INTO partial_close_workflow_events_v4 (workflow_id,revision,event_type,payload_json,payload_sha256,occurred_at_utc)
    VALUES (?,3,?,?,?,UTC_TIMESTAMP(3))`, [row.id,status,JSON.stringify(event),sha256Canonical(event)])
  await db.execute(`INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'partial_close_workflow',?,'execution.partial-close.reviewed',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
  [randomUUID(),row.id,JSON.stringify({workflow_id:row.id,user_id:scope.userId,trading_account_id:scope.accountId,revision:3,child_intent_id:child?.intent.id ?? null})])
  return {workflowId:row.id,revision:3,status,childIntentId:child?.intent.id ?? null,rejectCode:review.evaluation.rejectCode,replayed:false}
}

async function utcNow(db: PoolConnection): Promise<Date> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT @@session.time_zone zone,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
  const at = Number(rows[0]?.now_msc)
  if (!['+00:00','UTC'].includes(String(rows[0]?.zone)) || !Number.isSafeInteger(at) || at < 1) fail('clock_invalid')
  return new Date(at)
}

async function verifyChild(db: PoolConnection, child: PositionProtectionChild): Promise<void> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT i.operation_id,i.user_id,CAST(i.trading_account_id AS CHAR) account_id,
    i.source_type,i.source_id,i.position_workflow_id,i.request_sha256,i.expected_state_sha256,i.action_id,i.action_kind,
    i.risk_decision_id,i.trade_decision_id,i.user_command_id,i.risk_decision_revision,i.account_risk_revision,i.idempotency_key,
    UNIX_TIMESTAMP(i.expires_at_utc)*1000 expires_msc,UNIX_TIMESTAMP(i.created_at_utc)*1000 created_msc,
    p.action_json,p.action_sha256,p.expected_state_json,p.expected_state_sha256 payload_expected_hash,
    o.parent_operation_id,o.source_type operation_source_type,o.source_id operation_source_id,o.request_sha256 operation_request_hash,o.resource_id,
    o.user_id operation_user_id,CAST(o.trading_account_id AS CHAR) operation_account_id,o.kind operation_kind,
    o.idempotency_key operation_key,o.idempotency_scope operation_scope,o.resource_type
    FROM execution_intents i JOIN execution_intent_payloads p ON p.execution_intent_id=i.id JOIN operations o ON o.id=i.operation_id WHERE i.id=? FOR SHARE`, [child.intent.id])
  const row = rows[0], i = child.intent, o = child.operation
  if (rows.length !== 1 || !row || row.operation_id !== o.id || row.user_id !== i.userId || row.account_id !== i.accountId
    || row.source_type !== i.sourceType || row.source_id !== i.sourceId || row.position_workflow_id !== i.sourceId
    || row.risk_decision_id !== null || row.trade_decision_id !== null || row.user_command_id !== null || row.risk_decision_revision !== null
    || Number(row.account_risk_revision) !== i.action.expectedState.riskRevision || row.idempotency_key !== i.idempotencyKey
    || Number(row.expires_msc) !== Date.parse(i.expiresAt) || Number(row.created_msc) !== Date.parse(i.createdAt)
    || row.request_sha256 !== i.requestHash || row.expected_state_sha256 !== i.expectedStateHash || row.payload_expected_hash !== i.expectedStateHash
    || row.action_id !== i.actionId || row.action_kind !== i.actionKind || row.action_sha256 !== sha256Canonical(i.action)
    || sha256Canonical(parse(row.action_json)) !== row.action_sha256 || sha256Canonical(parse(row.expected_state_json)) !== i.expectedStateHash
    || row.parent_operation_id !== o.parentOperationId || row.operation_source_type !== o.sourceType || row.operation_source_id !== o.sourceId
    || row.operation_user_id !== o.userId || row.operation_account_id !== o.accountId || row.operation_kind !== o.kind
    || row.operation_key !== o.idempotencyKey || row.operation_scope !== o.idempotencyScope || row.resource_type !== o.resourceType
    || row.operation_request_hash !== o.requestHash || row.resource_id !== i.id) fail('child_corrupt')
}
