import { BridgeCommandError, createBridgeCommand, type BridgeCommand } from './bridge-command.js'
import type { PositionProtectionChild } from './position-protection-child.js'
import { reviewPositionProtectionCommand, type PositionProtectionCommandReview } from './position-protection-command-review.js'
import { sha256Canonical } from './execution.js'
import { partialCloseVolumeEquals } from './partial-close-protection.js'

export interface PositionProtectionCommandBinding {
  workflowId: string
  childIntentId: string
  bridgeCommandId: string
  commandHash: string
  authorityHash: string
  authority: PositionProtectionCommandReview
}
function fail(): never { throw new BridgeCommandError('position_protection_command_binding_invalid',409) }

export function bindPositionProtectionCommand(child: PositionProtectionChild, authority: PositionProtectionCommandReview,
  command: BridgeCommand, now: Date): PositionProtectionCommandBinding {
  const checked = reviewPositionProtectionCommand(child,authority.review,now), target = child.request.target
  if (sha256Canonical(checked) !== sha256Canonical(authority) || command.executionIntentId !== child.intent.id || command.commandSequence !== 1
    || command.userId !== child.request.userId || command.accountId !== child.request.accountId || command.action !== 'position.protection.set'
    || command.route.terminalInstanceId !== target.terminalInstanceId || command.route.brokerServer !== target.brokerServer || command.route.login !== target.login
    || sha256Canonical(command.request.payload.params) !== sha256Canonical(authority.action.parameters)
    || Date.parse(command.deadlineAt) > Date.parse(authority.expiresAt) || Date.parse(command.deadlineAt) <= now.getTime()
    || Date.parse(command.issuedAt) > now.getTime()) fail()
  const state = command.request.payload.expected_state
  if (!state || state.ticket !== target.ticket || state.symbol !== target.symbol || state.direction !== target.side
    || typeof state.volume !== 'string' || !partialCloseVolumeEquals(state.volume,child.request.remainingVolume)) fail()
  const rebuilt = createBridgeCommand({executionIntentId:command.executionIntentId,commandSequence:1,userId:command.userId,accountId:command.accountId,
    terminalProfileId:command.terminalProfileId,route:command.route,action:command.action,params:command.request.payload.params,
    expectedState:state,deadlineAt:command.deadlineAt},new Date(command.issuedAt))
  if (rebuilt.id !== command.id || rebuilt.requestHash !== command.requestHash || rebuilt.idempotencyKey !== command.idempotencyKey
    || sha256Canonical(rebuilt.request) !== sha256Canonical(command.request)) fail()
  return {workflowId:child.request.workflowId,childIntentId:child.intent.id,bridgeCommandId:command.id,commandHash:command.requestHash,
    authorityHash:sha256Canonical(authority),authority:structuredClone(authority)}
}
