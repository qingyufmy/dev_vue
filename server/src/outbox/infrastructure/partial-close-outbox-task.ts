import { PARTIAL_CLOSE_OUTBOX_TYPES, type ClaimedOutboxEvent } from '../application/outbox-ports.js'
import { parsePartialCloseWorkflowJob, type PartialCloseWorkflowTaskQueue } from '../../queue/partial-close-workflow-queue.js'

export async function publishPartialCloseWorkflow(event: ClaimedOutboxEvent, queue?: PartialCloseWorkflowTaskQueue): Promise<boolean> {
  if (!(PARTIAL_CLOSE_OUTBOX_TYPES as readonly string[]).includes(event.eventType)) return false
  if (!queue) throw Error('partial_close_queue_unavailable')
  const payload = event.payload, expectedKeys = ['workflow_id','user_id','trading_account_id']
  if (event.eventType !== 'execution.partial-close.requested') {
    expectedKeys.push('revision')
    if (!Number.isSafeInteger(payload.revision) || Number(payload.revision) < 2) throw Error('partial_close_outbox_revision_invalid')
  }
  if (event.eventType === 'execution.partial-close.reviewed') {
    expectedKeys.push('child_intent_id')
    if (payload.child_intent_id !== null && (typeof payload.child_intent_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.child_intent_id))) throw Error('partial_close_outbox_child_invalid')
  }
  if (Object.keys(payload).length !== expectedKeys.length || Object.keys(payload).some(key => !expectedKeys.includes(key))) throw Error('partial_close_outbox_payload_invalid')
  const scope = parsePartialCloseWorkflowJob({workflowId:payload.workflow_id,userId:payload.user_id,accountId:payload.trading_account_id})
  // The event's revision/child are observations. Load authoritative state by workflow, never execute event-supplied actions.
  await queue.add('execution.partial-close.run',scope,{jobId:event.eventId})
  return true
}
