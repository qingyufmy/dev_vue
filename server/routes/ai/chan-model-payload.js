// Keep the model-facing Chan payload limited to calculated structure objects
// and a small boolean evidence-capability whitelist.
// The complete Chan result remains in the internal market snapshot for audit
// and replay; this module only creates an isolated model-bound projection.

export const CHAN_MODEL_STRUCTURE_FIELDS = Object.freeze([
  'latest_structure',
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
  'price_vs_center',
  'trend_state',
  'divergence',
  'forming_divergence',
  'recent_divergences',
  'entry_candidates',
])

export const CHAN_MODEL_EVIDENCE_CAPABILITY_FIELDS = Object.freeze([
  'history_complete',
  'continuity_complete',
  'topology_input_complete',
  'data_complete',
  'local_structure_usable',
  'segment_direction_usable',
  'center_structure_usable',
  'entry_structure_usable',
  'divergence_usable',
])

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsJsonReferenceOrCycle(value, visiting = new WeakSet(), visited = new WeakSet()) {
  if (!value || typeof value !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(value, '$ref')) return true
  if (visiting.has(value)) return true
  if (visited.has(value)) return false
  visiting.add(value)
  const children = Array.isArray(value) ? value : Object.values(value)
  const forbidden = children.some(item => containsJsonReferenceOrCycle(item, visiting, visited))
  visiting.delete(value)
  visited.add(value)
  return forbidden
}

function throwReferenceForbidden() {
  const error = new Error('chan_model_payload_reference_forbidden')
  error.code = 'chan_model_payload_reference_forbidden'
  throw error
}

/**
 * Project one computed Chan result onto the fixed model-facing structure and
 * capability contract. Existing structure values are copied without mutation;
 * capability values are normalized to booleans and internal reasons are omitted.
 */
export function projectChanStructureForModel(chan) {
  if (!isObject(chan)) return {}
  if (containsJsonReferenceOrCycle(chan)) throwReferenceForbidden()
  const projected = {}
  for (const field of CHAN_MODEL_STRUCTURE_FIELDS) {
    if (hasOwn(chan, field)) projected[field] = structuredClone(chan[field])
  }
  // v7 separates the latest active market structure from historical topology.
  // Keep legacy projections unchanged, but when latest_structure is present do
  // not send retired segments/centers beside the current judgement.
  if (isObject(chan.latest_structure)) {
    delete projected.prev_segment
    delete projected.current_center
    delete projected.latest_center
    const activeSegment = chan.latest_structure.active_segment
    const activeStableId = String(activeSegment?.stable_id || '')
    const currentStableId = String(chan.current_segment?.stable_id || '')
    const candidateStableId = String(chan.candidate_segment?.stable_id || '')
    const confirmedActiveMatches = activeSegment?.confirmed === true
      && activeStableId && activeStableId === currentStableId
    const formingActiveMatches = activeSegment?.confirmed === false
      && activeStableId && activeStableId === candidateStableId
    if (!confirmedActiveMatches) delete projected.current_segment
    if (!formingActiveMatches) delete projected.candidate_segment
    if (!isObject(chan.active_center)) {
      delete projected.active_center
      delete projected.price_vs_center
    }
  }
  if (isObject(chan.evidence_capabilities)) {
    projected.evidence_capabilities = Object.fromEntries(CHAN_MODEL_EVIDENCE_CAPABILITY_FIELDS
      .map(field => [field, chan.evidence_capabilities[field] === true]))
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
