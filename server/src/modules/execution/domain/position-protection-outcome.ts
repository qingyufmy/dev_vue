import { BridgeCommandError, type BridgeCommand } from './bridge-command.js'
import type { PositionProtectionChild } from './position-protection-child.js'
import { sha256Canonical } from './execution.js'
import { partialCloseVolumeEquals, type ProtectionProjection, type ProtectionTarget } from './partial-close-protection.js'

/** SQL adapter must verify the original terminal result hash before supplying this receipt. */
export interface PositionProtectionSuccessReceipt {
  commandId: string
  childIntentId: string
  requestHash: string
  resultHash: string
  completedAt: number
}
export interface PositionProtectionOutcomeProjection extends Omit<ProtectionProjection, 'positions'> {
  positions: readonly { target: ProtectionTarget; volume: string; stopLoss?: string | null; takeProfit?: string | null }[]
}
export type PositionProtectionOutcome =
  | { state: 'waiting'; reason: 'command_queued' | 'terminal_result_pending' | 'receipt_pending' | 'projection_pending' | 'protection_not_observed' }
  | { state: 'reconcile'; commandId: string }
  | { state: 'stopped'; reason: 'command_not_completed' | 'position_absent' | 'position_changed' | 'command_not_created_before_expiry' }
  | { state: 'succeeded'; commandId: string; resultHash: string; projectionRevision: number; observedAt: number }

const routeKeys = ['userId', 'accountId', 'terminalInstanceId', 'brokerServer', 'login'] as const
const targetKeys = [...routeKeys, 'ticket', 'positionIdentifier', 'symbol', 'side'] as const
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0
function invalid(): never { throw new BridgeCommandError('position_protection_outcome_evidence_invalid', 409) }

/** A success response alone is not proof that protection is visible on the exact residual position. */
export function evaluatePositionProtectionOutcome(input: {
  child: PositionProtectionChild; command: BridgeCommand; dispatchedPositionRevision: number | null
  receipt: PositionProtectionSuccessReceipt | null; projection: PositionProtectionOutcomeProjection | null
  now: number; maxProjectionAgeMs: number
}): PositionProtectionOutcome {
  const { child, command, receipt, projection, now } = input
  const target = { ...child.request.target, userId: String(child.request.userId), accountId: child.request.accountId }
  if (!validTime(now) || !Number.isSafeInteger(input.maxProjectionAgeMs) || input.maxProjectionAgeMs < 1 || input.maxProjectionAgeMs > 60_000
    || command.executionIntentId !== child.intent.id || command.userId !== child.request.userId || command.accountId !== child.request.accountId
    || command.action !== 'position.protection.set' || command.route.terminalInstanceId !== target.terminalInstanceId
    || command.route.brokerServer !== target.brokerServer || command.route.login !== target.login
    || command.request.payload.params.ticket !== target.ticket
    || sha256Canonical(command.request.payload.params) !== sha256Canonical(child.intent.action.parameters)) invalid()
  // Expiry can stop a new dispatch, but must never erase an unknown terminal outcome.
  if (command.status === 'uncertain' || command.status === 'reconciling') return { state: 'reconcile', commandId: command.id }
  if (command.status === 'queued') return { state: 'waiting', reason: 'command_queued' }
  if (command.status === 'dispatched' || command.status === 'accepted') return { state: 'waiting', reason: 'terminal_result_pending' }
  if (command.status === 'failed' || command.status === 'rejected') return { state: 'stopped', reason: 'command_not_completed' }
  if (command.status !== 'succeeded' || command.errorCode !== null) invalid()
  if (!receipt) return { state: 'waiting', reason: 'receipt_pending' }
  const completed = Date.parse(command.completedAt ?? '')
  if (receipt.commandId !== command.id || receipt.childIntentId !== child.intent.id || receipt.requestHash !== command.requestHash
    || !/^[0-9a-f]{64}$/.test(receipt.resultHash) || receipt.resultHash !== command.resultHash
    || !validTime(receipt.completedAt) || receipt.completedAt !== completed || completed > now
    || completed < Date.parse(command.issuedAt) || !command.dispatchedAt
    || !validTime(Date.parse(command.dispatchedAt)) || completed < Date.parse(command.dispatchedAt)
    || !Number.isSafeInteger(input.dispatchedPositionRevision) || Number(input.dispatchedPositionRevision) < 1) invalid()
  if (!projection) return { state: 'waiting', reason: 'projection_pending' }
  if (routeKeys.some(key => projection.route[key] !== target[key])) invalid()
  if (!projection.complete || !Number.isSafeInteger(projection.revision) || projection.revision <= Number(input.dispatchedPositionRevision)
    || !validTime(projection.observedAt) || projection.observedAt < completed || projection.observedAt > now
    || now - projection.observedAt > input.maxProjectionAgeMs) return { state: 'waiting', reason: 'projection_pending' }
  const candidates = projection.positions.filter(p => p.target.ticket === target.ticket || p.target.positionIdentifier === target.positionIdentifier)
  if (!candidates.length) return { state: 'stopped', reason: 'position_absent' }
  const position = candidates[0]!
  if (candidates.length !== 1 || targetKeys.some(key => position.target[key] !== target[key])
    || !partialCloseVolumeEquals(position.volume, child.request.remainingVolume)) return { state: 'stopped', reason: 'position_changed' }
  const params = command.request.payload.params, expected = command.request.payload.expected_state
  for (const [field, observed] of [['stop_loss', position.stopLoss], ['take_profit', position.takeProfit]] as const) {
    const wanted = params[field] ?? expected?.[field]
    if (wanted !== null && typeof wanted !== 'string') invalid()
    if (observed === undefined || (wanted === null ? observed !== null
      : typeof observed !== 'string' || !partialCloseVolumeEquals(wanted, observed))) {
      return { state: 'waiting', reason: 'protection_not_observed' }
    }
  }
  return { state: 'succeeded', commandId: command.id, resultHash: receipt.resultHash,
    projectionRevision: projection.revision, observedAt: projection.observedAt }
}
