import { createHash } from 'node:crypto'
import { BridgeCommandError, type BridgeCommand } from './bridge-command.js'
import type { ExecutionAction, ExecutionJsonObject } from './execution-input.js'
import { evaluatePartialCloseProtection, partialCloseVolumeEquals, type PartialCloseProtectionPlan } from './partial-close-protection.js'

const object = (value: unknown): value is ExecutionJsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
function invalid(): never { throw new BridgeCommandError('partial_close_compiled_intent_invalid', 409) }
const uint64 = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n

/** Build only from the hash-verified, locked execution action, never from Bridge params alone. */
export function buildPartialClosePlan(command: BridgeCommand, action: ExecutionAction, intentExpiresAt: number): PartialCloseProtectionPlan | null {
  const parameters = action.parameters
  if (!Object.hasOwn(parameters, 'after_close_protection')) {
    if (Object.hasOwn(parameters, 'after_close_target')) invalid()
    return null
  }
  const protection = parameters.after_close_protection, target = parameters.after_close_target
  const expected = command.request.payload.expected_state, wire = command.request.payload.params
  if (action.kind !== 'close_position' || command.action !== 'position.close'
    || !object(protection) || !object(target) || !expected
    || Object.hasOwn(parameters, 'close_percent')
    || Object.keys(protection).length < 1 || Object.keys(protection).some(key => !['stop_loss', 'take_profit'].includes(key))
    || Object.keys(target).length !== 3 || Object.keys(target).some(key => !['position_identifier', 'initial_volume', 'positions_revision'].includes(key))
    || !uint64(target.position_identifier) || !uint64(parameters.ticket)
    || typeof target.initial_volume !== 'string' || typeof parameters.volume !== 'string'
    || !Number.isSafeInteger(target.positions_revision) || Number(target.positions_revision) < 1
    || target.positions_revision !== action.expectedState.positionsRevision
    || parameters.ticket !== wire.ticket || parameters.ticket !== expected.ticket
    || typeof wire.volume !== 'string' || !partialCloseVolumeEquals(wire.volume, parameters.volume)
    || typeof expected.volume !== 'string' || !partialCloseVolumeEquals(expected.volume, target.initial_volume)
    || typeof expected.symbol !== 'string' || !expected.symbol || !['buy', 'sell'].includes(String(expected.direction))
    || Object.keys(wire).some(key => !['ticket', 'volume', 'deviation'].includes(key))
    || !Number.isSafeInteger(intentExpiresAt) || intentExpiresAt < Date.parse(command.deadlineAt)) invalid()
  const prices: PartialCloseProtectionPlan['protection'] = {
    ...(Object.hasOwn(protection, 'stop_loss') ? { stopLoss: protection.stop_loss as string } : {}),
    ...(Object.hasOwn(protection, 'take_profit') ? { takeProfit: protection.take_profit as string } : {}),
  }
  if (Object.values(prices).some(value => typeof value !== 'string' || !partialCloseVolumeEquals(value, value))) invalid()
  // Identity depends on the parent, not prices: an altered plan conflicts with the existing workflow.
  const hash = createHash('sha256').update(`partial-close-protection:v1:${command.executionIntentId}`).digest('hex')
  const workflowId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const plan: PartialCloseProtectionPlan = { workflowId, parentIntentId: command.executionIntentId, parentCommandId: command.id,
    target: { userId: String(command.userId), accountId: command.accountId, terminalInstanceId: command.route.terminalInstanceId,
      brokerServer: command.route.brokerServer, login: command.route.login, positionIdentifier: target.position_identifier,
      ticket: parameters.ticket, symbol: expected.symbol, side: expected.direction as 'buy' | 'sell' },
    initialVolume: target.initial_volume, closeVolume: parameters.volume, initialRevision: Number(target.positions_revision),
    expiresAt: intentExpiresAt, protection: prices }
  if (evaluatePartialCloseProtection({ plan, parentState: 'pending', history: null, projection: null,
    now: Date.parse(command.issuedAt), maxProjectionAgeMs: 1 }).state !== 'wait_close') invalid()
  return plan
}
