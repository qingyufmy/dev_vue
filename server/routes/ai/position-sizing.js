export const POSITION_SIZE_TIERS = Object.freeze({
  observe: Object.freeze({ factor: 0, rank: 0, label: '不建仓' }),
  probe: Object.freeze({ factor: 0.25, rank: 1, label: '试探仓' }),
  light: Object.freeze({ factor: 0.5, rank: 2, label: '轻仓' }),
  standard: Object.freeze({ factor: 1, rank: 3, label: '标准仓' }),
})

const TRADE_TIERS = new Set(['probe', 'light', 'standard'])

export function normalizePositionSizeTier(value, signalType = 'hold') {
  if (String(signalType || '').toLowerCase() === 'hold') return 'observe'
  const tier = String(value || '').trim().toLowerCase()
  return TRADE_TIERS.has(tier) ? tier : null
}

export function positionSizeFactor(tier) {
  return POSITION_SIZE_TIERS[tier]?.factor ?? 0
}

export function positionSizeLabel(tier) {
  return POSITION_SIZE_TIERS[tier]?.label || POSITION_SIZE_TIERS.observe.label
}

export function capPositionSizeTier(tier, maximumTier = 'standard') {
  const normalized = normalizePositionSizeTier(tier, 'buy') || 'probe'
  const maximum = normalizePositionSizeTier(maximumTier, 'buy') || 'standard'
  return POSITION_SIZE_TIERS[normalized].rank <= POSITION_SIZE_TIERS[maximum].rank
    ? normalized
    : maximum
}

export function resolvePositionSizeTier({ requestedTier, signalType, isAdd = false, evidenceCap = 'standard' } = {}) {
  const normalized = normalizePositionSizeTier(requestedTier, signalType)
  if (String(signalType || '').toLowerCase() === 'hold') {
    return { tier: 'observe', factor: 0, downgraded: false }
  }
  if (!normalized) return null
  const maximum = isAdd ? capPositionSizeTier(evidenceCap, 'probe') : evidenceCap
  const tier = capPositionSizeTier(normalized, maximum)
  return { tier, factor: positionSizeFactor(tier), downgraded: tier !== normalized }
}
