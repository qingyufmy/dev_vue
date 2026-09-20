export type PositionSizeTier = 'probe' | 'light' | 'standard'
const quarters: Record<PositionSizeTier, bigint> = { probe: 1n, light: 2n, standard: 4n }
const scale = 10n ** 18n

export class PositionSizingError extends Error {
  constructor(public readonly code: string) { super(code) }
}

function tier(value: unknown): PositionSizeTier {
  if (value !== 'probe' && value !== 'light' && value !== 'standard') throw new PositionSizingError('position_size_tier_invalid')
  return value
}

// Legacy confidence is normalized to [0,1]; V4's frozen decision uses [0,100].
// Completeness is a server fact, not the model's own dataGaps declaration.
export function legacyPositionEvidenceCap(confidencePercent: number, marketCompleteness: 'complete' | 'partial'): PositionSizeTier {
  if (!Number.isFinite(confidencePercent) || confidencePercent < 0 || confidencePercent > 100
    || !['complete', 'partial'].includes(marketCompleteness)) throw new PositionSizingError('position_size_evidence_invalid')
  if (marketCompleteness === 'partial') return 'probe'
  return confidencePercent >= 75 ? 'standard' : confidencePercent >= 62 ? 'light' : 'probe'
}

export function resolvePositionSizeTier(input: { requested: unknown; evidenceCap: unknown; applyAddCap: boolean }): PositionSizeTier {
  const requested = tier(input.requested), cap = tier(input.evidenceCap)
  if (typeof input.applyAddCap !== 'boolean') throw new PositionSizingError('position_size_add_state_invalid')
  if (input.applyAddCap) return 'probe'
  return quarters[requested] <= quarters[cap] ? requested : cap
}

function positive(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/.test(value)) throw new PositionSizingError('position_size_decimal_invalid')
  const [whole, fraction = ''] = value.split('.')
  const result = BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'))
  if (result <= 0n) throw new PositionSizingError('position_size_decimal_nonpositive')
  return result
}

function decimal(value: bigint): string {
  const fraction = (value % scale).toString().padStart(18, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? '.' + fraction : ''}`
}

export interface PositionRiskCeilings {
  /** Trusted strategy configuration only; never copy this from model action parameters. */
  strategyRiskCeilingPercent?: string
  /** A suggestion may only tighten the budget after the tier fraction. */
  actionRiskCeilingPercent?: string
}

function percentage(value: string): bigint {
  const amount = positive(value)
  if (amount > 100n * scale) throw new PositionSizingError('position_size_limits_invalid')
  return amount
}

function budgetQuarterUnits(accountPercent: bigint, resolvedTier: PositionSizeTier, ceilings: PositionRiskCeilings): bigint {
  const strategy = ceilings.strategyRiskCeilingPercent === undefined ? accountPercent : percentage(ceilings.strategyRiskCeilingPercent)
  const base = accountPercent < strategy ? accountPercent : strategy
  const tierBudget = base * quarters[resolvedTier]
  if (ceilings.actionRiskCeilingPercent === undefined) return tierBudget
  const actionBudget = percentage(ceilings.actionRiskCeilingPercent) * 4n
  return tierBudget < actionBudget ? tierBudget : actionBudget
}

// Cross multiply without rounding money, prices, or the budget. Fixed-volume
// orders use the full base budget; tier callers must pass their resolved tier.
export function positionVolumeExceedsRiskBudget(input: {
  equity: string; maxRiskPerTradePercent: string; volume: string
  entry: string; stopLoss: string; tickSize: string; tickValue: string
  resolvedTier?: PositionSizeTier
} & PositionRiskCeilings): boolean {
  const equity = positive(input.equity), volume = positive(input.volume)
  const entry = positive(input.entry), stop = positive(input.stopLoss)
  const tickSize = positive(input.tickSize), tickValue = positive(input.tickValue)
  const percent = /^0(?:\.0{1,18})?$/.test(input.maxRiskPerTradePercent) ? 0n : percentage(input.maxRiskPerTradePercent)
  const budget = budgetQuarterUnits(percent, tier(input.resolvedTier ?? 'standard'), input)
  const distance = entry > stop ? entry - stop : stop - entry
  if (distance === 0n) throw new PositionSizingError('position_size_stop_distance_zero')
  return 400n * distance * tickValue * volume > equity * budget * tickSize
}

// Tick-metadata path only. Caller resolves side, frozen revisions, evidence cap
// and add status before invoking this pure calculation; existing risk gates
// still validate the resulting concrete action and aggregate account exposure.
export function calculatePositionTierVolume(input: {
  resolvedTier: PositionSizeTier; equity: string; maxRiskPerTradePercent: string
  entry: string; stopLoss: string; tickSize: string; tickValue: string
  volumeMin: string; volumeMax: string; volumeStep: string; maxOrderVolume: string
} & PositionRiskCeilings): { volume: string; resolvedTier: PositionSizeTier; calculationSource: 'symbol_tick_metadata' } {
  const resolvedTier = tier(input.resolvedTier)
  const equity = positive(input.equity), percent = positive(input.maxRiskPerTradePercent)
  const entry = positive(input.entry), stop = positive(input.stopLoss)
  const tickSize = positive(input.tickSize), tickValue = positive(input.tickValue)
  const minimum = positive(input.volumeMin), maximum = positive(input.volumeMax)
  const step = positive(input.volumeStep), policyMaximum = positive(input.maxOrderVolume)
  if (percent > 100n * scale || maximum < minimum) throw new PositionSizingError('position_size_limits_invalid')
  const distance = entry > stop ? entry - stop : stop - entry
  if (distance === 0n) throw new PositionSizingError('position_size_stop_distance_zero')
  // Keep the budget/loss ratio exact until the final downward lattice choice.
  // This is the accepted result of legacy half-up rounding followed by its
  // over-budget step-down guard; it never exceeds any explicit cap.
  const budget = budgetQuarterUnits(percent, resolvedTier, input)
  const budgetVolume = equity * budget * tickSize / (400n * distance * tickValue)
  const capped = [budgetVolume, maximum, policyMaximum].reduce((a, b) => a < b ? a : b)
  if (capped < minimum) throw new PositionSizingError('position_size_below_minimum')
  const volume = minimum + (capped - minimum) / step * step
  return { volume: decimal(volume), resolvedTier, calculationSource: 'symbol_tick_metadata' }
}
