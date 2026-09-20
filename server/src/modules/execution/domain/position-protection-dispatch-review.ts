import { BridgeCommandError, type BridgeCommand } from './bridge-command.js'
import { bindPositionProtectionCommand, type PositionProtectionCommandBinding } from './position-protection-command-binding.js'
import type { PositionProtectionChild } from './position-protection-child.js'
import type { PositionProtectionCommandReview } from './position-protection-command-review.js'
import { sha256Canonical } from './execution.js'

/** Recheck the immutable command against fresh authority without replacing its creation binding. */
export function reviewPositionProtectionDispatch(child: PositionProtectionChild, command: BridgeCommand,
  stored: PositionProtectionCommandBinding, boundAt: Date, current: PositionProtectionCommandReview, now: Date) {
  const original = bindPositionProtectionCommand(child, stored.authority, command, boundAt)
  const fresh = bindPositionProtectionCommand(child, current, command, now)
  const previousVersions = stored.authority.action.expectedState
  if (command.status !== 'queued' || command.revision !== 1 || sha256Canonical(original) !== sha256Canonical(stored)
    || now.getTime() < boundAt.getTime()
    || Date.parse(current.review.evaluation.evaluatedAt) < Date.parse(stored.authority.review.evaluation.evaluatedAt)
    || Object.keys(previousVersions).some(key => Number(current.action.expectedState[key]) < Number(previousVersions[key]))) {
    throw new BridgeCommandError('position_protection_dispatch_review_invalid', 409)
  }
  return { workflowId: child.request.workflowId, childIntentId: child.intent.id, commandId: command.id,
    creationBindingHash: sha256Canonical(stored), commandHash: command.requestHash,
    authority: structuredClone(current), authorityHash: fresh.authorityHash, checkedAt: now.toISOString() }
}
