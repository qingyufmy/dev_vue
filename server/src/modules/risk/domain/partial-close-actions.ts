import { matchesMarketSymbol } from '../../trading/index.js'
import type { RiskAction, RiskJsonObject } from './risk-action.js'

const scale = 10n ** 18n
export class PartialCloseError extends Error {
  constructor(public readonly code: string) { super(code) }
}
function positive(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,28})(?:\.\d{1,18})?$/.test(value)) throw new PartialCloseError('partial_close_decimal_invalid')
  const [whole, fraction = ''] = value.split('.')
  const result = BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'))
  if (result <= 0n) throw new PartialCloseError('partial_close_decimal_invalid')
  return result
}
const decimal = (value: bigint) => `${value / scale}.${(value % scale).toString().padStart(18, '0')}`.replace(/\.?0+$/, '')

export function calculatePartialCloseVolume(input: { currentVolume: unknown; closePercent: unknown; volumeMin: string; volumeMax: string; volumeStep: string }) {
  const current = positive(input.currentVolume), percent = positive(input.closePercent)
  const minimum = positive(input.volumeMin), maximum = positive(input.volumeMax), step = positive(input.volumeStep)
  if (percent >= 100n * scale || minimum > maximum || current % step !== 0n) throw new PartialCloseError('partial_close_limits_invalid')
  const desired = current * percent / (100n * scale) / step * step
  const maximumClosable = current >= minimum ? (current - minimum) / step * step : 0n
  const volume = desired < maximumClosable ? desired : maximumClosable
  if (volume < minimum || current - volume < minimum) throw new PartialCloseError('partial_close_below_minimum')
  if (volume > maximum) throw new PartialCloseError('partial_close_maximum_exceeded')
  return { volume: decimal(volume), remainingVolume: decimal(current - volume) }
}

interface Input {
  result: { actions: RiskAction[] }
  positions: RiskJsonObject[]
  instrument: { symbol: string; volumeMin: string; volumeMax: string; volumeStep: string; revision: number }
  currentRevisions: { positions: number; contract: number }
}
interface ResolutionRule { code: string; outcome: 'passed'; actionId: string; details: RiskJsonObject }
export function resolvePartialCloseActions(input: Input): { actions: RiskAction[]; rules: ResolutionRule[] } {
  const rules: ResolutionRule[] = []
  const actions = input.result.actions.map(action => {
    if (Object.hasOwn(action.parameters, 'after_close_target')) throw new PartialCloseError('partial_close_target_reserved')
    const percentMode = Object.hasOwn(action.parameters, 'close_percent')
    const afterClose = Object.hasOwn(action.parameters, 'after_close_protection')
    if (!percentMode && !afterClose) return action
    if (action.kind !== 'close_position' || ['position_size_tier', 'position_size_factor'].some(key => Object.hasOwn(action.parameters, key))
      || (percentMode && Object.hasOwn(action.parameters, 'volume'))) throw new PartialCloseError('partial_close_mode_conflict')
    const ticket = action.parameters.ticket
    if (typeof ticket !== 'string' || !ticket) throw new PartialCloseError('partial_close_target_invalid')
    const positions = input.positions.filter(position => String(position.ticket ?? '') === ticket)
    if (positions.length !== 1 || !matchesMarketSymbol(String(positions[0]!.symbol), input.instrument.symbol)) throw new PartialCloseError('partial_close_target_invalid')
    if (input.result.actions.filter(other => ['close_position', 'modify_position'].includes(other.kind) && other.parameters.ticket === ticket).length !== 1) {
      throw new PartialCloseError('partial_close_target_conflict')
    }
    if (![input.currentRevisions.contract, input.currentRevisions.positions].every(value => Number.isSafeInteger(value) && value > 0)
      || input.instrument.revision !== input.currentRevisions.contract
      || action.expectedState.contractRevision !== input.currentRevisions.contract
      || action.expectedState.positionsRevision !== input.currentRevisions.positions) throw new PartialCloseError('partial_close_revision_stale')
    const sized = percentMode ? calculatePartialCloseVolume({ currentVolume: positions[0]!.volume, closePercent: action.parameters.close_percent,
      volumeMin: input.instrument.volumeMin, volumeMax: input.instrument.volumeMax, volumeStep: input.instrument.volumeStep })
      : explicitPartialVolume(positions[0]!.volume, action.parameters.volume, input.instrument)
    if (afterClose) {
      const protection = action.parameters.after_close_protection
      if (!protection || typeof protection !== 'object' || Array.isArray(protection) || Object.keys(protection).length < 1
        || Object.keys(protection).length > 2 || Object.keys(protection).some(key => !['stop_loss', 'take_profit'].includes(key))) {
        throw new PartialCloseError('partial_close_protection_invalid')
      }
      for (const value of Object.values(protection)) positive(value)
      const identifier = positions[0]!.positionIdentifier
      if (typeof identifier !== 'string' || !/^[1-9][0-9]{0,19}$/.test(identifier) || BigInt(identifier) > 18446744073709551615n
        || input.positions.filter(position => position.positionIdentifier === identifier).length !== 1) throw new PartialCloseError('partial_close_identifier_invalid')
    }
    const parameters: RiskJsonObject = { ...action.parameters, volume: sized.volume }
    delete parameters.close_percent
    if (percentMode) rules.push({ code: 'RISK_PARTIAL_CLOSE_VOLUME_RESOLVED', outcome: 'passed', actionId: action.actionId,
      details: { ticket, close_percent: action.parameters.close_percent!, current_volume: positions[0]!.volume!,
        resolved_volume: sized.volume, remaining_volume: sized.remainingVolume, volume_step: input.instrument.volumeStep,
        positions_revision: input.currentRevisions.positions, contract_revision: input.currentRevisions.contract } })
    if (afterClose) {
      parameters.after_close_protection = structuredClone(action.parameters.after_close_protection!)
      parameters.after_close_target = { position_identifier: positions[0]!.positionIdentifier!, initial_volume: positions[0]!.volume!, positions_revision: input.currentRevisions.positions }
      rules.push({ code: 'RISK_AFTER_CLOSE_PROTECTION_DEFERRED', outcome: 'passed', actionId: action.actionId,
        details: { ticket, position_identifier: positions[0]!.positionIdentifier!, current_volume: positions[0]!.volume!,
          resolved_volume: sized.volume, remaining_volume: sized.remainingVolume, current_risk_review_required: true } })
    }
    return { ...action, parameters }
  })
  return { actions, rules }
}

export function explicitPartialVolume(currentValue: unknown, requestedValue: unknown, instrument: Input['instrument']) {
  const current = positive(currentValue), amount = positive(requestedValue), minimum = positive(instrument.volumeMin)
  const maximum = positive(instrument.volumeMax), step = positive(instrument.volumeStep)
  if (minimum > maximum || current % step !== 0n || amount % step !== 0n || amount < minimum || amount > maximum
    || amount >= current || current - amount < minimum) throw new PartialCloseError('partial_close_limits_invalid')
  return { volume: decimal(amount), remainingVolume: decimal(current - amount) }
}
