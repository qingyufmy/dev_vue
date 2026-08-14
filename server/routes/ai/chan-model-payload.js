// Keep the model-facing Chan payload limited to calculated structure objects.
// The complete Chan result remains in the internal market snapshot for audit
// and replay; this module only creates an isolated model-bound projection.

export const CHAN_MODEL_STRUCTURE_FIELDS = Object.freeze([
  'current_bi',
  'developing_bi',
  'recent_bis',
  'current_segment',
  'prev_segment',
  'candidate_segment',
  'current_center',
  'latest_center',
  'latest_bi_center',
  'active_center',
  'divergence',
  'forming_divergence',
  'recent_divergences',
  'entry_candidates',
])

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsJsonReference(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.some(item => containsJsonReference(item, seen))
  if (!value || typeof value !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(value, '$ref')) return true
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value).some(item => containsJsonReference(item, seen))
}

function throwReferenceForbidden() {
  const error = new Error('chan_model_payload_reference_forbidden')
  error.code = 'chan_model_payload_reference_forbidden'
  throw error
}

/**
 * Project one computed Chan result onto the fixed model-facing structure
 * contract. Existing values are copied without interpretation or mutation.
 */
export function projectChanStructureForModel(chan) {
  if (!isObject(chan)) return {}
  if (containsJsonReference(chan)) throwReferenceForbidden()
  const projected = {}
  for (const field of CHAN_MODEL_STRUCTURE_FIELDS) {
    if (hasOwn(chan, field)) projected[field] = structuredClone(chan[field])
  }
  return projected
}

/**
 * Clone a strategy context and project each timeframe's summary.chan object.
 * Non-Chan context (indicators, K-lines, and other neutral facts) is retained
 * as-is in the clone. A null/absent Chan value remains null/absent; no empty
 * structure is invented for a missing calculation result.
 */
export function projectStrategyContextChanForModel(strategyContext) {
  if (!isObject(strategyContext)) return {}
  const projected = structuredClone(strategyContext)
  const timeframes = projected.timeframes
  if (!isObject(timeframes)) return projected

  for (const frame of Object.values(timeframes)) {
    if (!isObject(frame) || !isObject(frame.summary) || !hasOwn(frame.summary, 'chan')) continue
    if (frame.summary.chan === null || frame.summary.chan === undefined) continue
    frame.summary.chan = projectChanStructureForModel(frame.summary.chan)
  }
  return projected
}
