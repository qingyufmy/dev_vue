import type { PartialCloseWorkflowProgress, PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import type { PositionProtectionPreparation } from './position-protection-preparation.js'
import { BridgeCommandError, bridgeCommandId } from '../domain/bridge-command.js'
import type { PositionProtectionOutcomeService } from './position-protection-outcome-service.js'

export type PartialCloseWorkflowWorkResult =
  | { workflowId: string; state: 'waiting'; reason: 'wait_close' | 'reconcile_close' | 'wait_history' | 'wait_projection' | 'terminal_result_pending' | 'receipt_pending' | 'projection_pending' | 'protection_not_observed' }
  | { workflowId: string; state: 'protection_reconcile'; childIntentId: string; commandId: string }
  | { workflowId: string; state: 'protection_prepared'; childIntentId: string; replayed: boolean }
  | { workflowId: string; state: 'stopped' | 'expired' | 'succeeded' }
export interface PartialCloseWorkflowWorker {
  run(scope: PartialCloseWorkflowScope): Promise<PartialCloseWorkflowWorkResult>
}
function fail(): never { throw new BridgeCommandError('partial_close_worker_state_invalid',409) }

/** Durable repositories own idempotency. Waiting is not completion, and preparation is not terminal execution. */
export function createPartialCloseWorkflowWorker(progress: PartialCloseWorkflowProgress, preparation: PositionProtectionPreparation,
  outcomes?: PositionProtectionOutcomeService): PartialCloseWorkflowWorker {
  return { async run(source) {
    const scope = structuredClone(source)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.workflowId)
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
      || !/^[1-9][0-9]{0,19}$/.test(scope.accountId) || BigInt(scope.accountId) > 18446744073709551615n) fail()
    const current = await progress.advance(structuredClone(scope))
    if (current.workflowId !== scope.workflowId || !Number.isSafeInteger(current.revision) || current.revision < 1) fail()
    if (current.status === 'succeeded') {
      if (current.revision !== 4) fail()
      return { workflowId: scope.workflowId, state: 'succeeded' }
    }
    if (current.status === 'awaiting_close') {
      const reason = current.assessment.state
      if (reason !== 'wait_close' && reason !== 'reconcile_close' && reason !== 'wait_history' && reason !== 'wait_projection') fail()
      return {workflowId:scope.workflowId,state:'waiting',reason}
    }
    if (current.status === 'stopped' || current.status === 'expired') return {workflowId:scope.workflowId,state:current.status}
    if (!['risk_review_required','protecting'].includes(current.status)) fail()
    const result = await preparation.prepare(structuredClone(scope))
    if (result.workflowId !== scope.workflowId || result.revision < current.revision) fail()
    if (result.revision === 4 && (result.status === 'succeeded' || result.status === 'stopped')) {
      if (!result.childIntentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.childIntentId)
        || (result.status === 'succeeded' && result.rejectCode !== null)) fail()
      return { workflowId: scope.workflowId, state: result.status }
    }
    if (result.revision !== 3) fail()
    if (result.status === 'stopped' || result.status === 'expired') {
      if (result.childIntentId !== null) fail()
      return {workflowId:scope.workflowId,state:result.status}
    }
    if (result.status !== 'protecting' || result.rejectCode !== null || !result.childIntentId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.childIntentId)) fail()
    if (outcomes) {
      const merged = await outcomes.merge(structuredClone(scope)), outcome = merged.outcome
      if (outcome.state === 'succeeded' || outcome.state === 'stopped') {
        if (merged.revision !== 4) fail()
        return { workflowId: scope.workflowId, state: outcome.state }
      }
      if (merged.revision !== 3) fail()
      if (outcome.state === 'reconcile') {
        if (outcome.commandId !== bridgeCommandId(result.childIntentId, 1)) fail()
        return { workflowId: scope.workflowId, state: 'protection_reconcile', childIntentId: result.childIntentId, commandId: outcome.commandId }
      }
      if (outcome.state !== 'waiting') fail()
      if (outcome.reason !== 'command_queued') return { workflowId: scope.workflowId, state: 'waiting', reason: outcome.reason }
    }
    return {workflowId:scope.workflowId,state:'protection_prepared',childIntentId:result.childIntentId,replayed:result.replayed}
  } }
}
