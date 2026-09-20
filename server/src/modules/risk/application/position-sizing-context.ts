import { contentHash, type JsonObject, type ProposedDecisionEvidenceReader } from '../../inference/index.js'
import { riskPolicyHash, type RiskEvaluationInput } from '../domain/risk.js'
import { legacyPositionEvidenceCap } from '../domain/position-tier-sizing.js'

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

function coverage(market: JsonObject): 'complete' | 'partial' | null {
  const value = market.candle_coverage
  if (!object(value) || value.version !== 1 || !['complete', 'partial'].includes(String(value.status))
    || !Array.isArray(value.frames) || !value.frames.length || !object(market.candles)) return null
  const seen = new Set<string>(); let partial = false
  for (const frame of value.frames) {
    if (!object(frame) || typeof frame.timeframe !== 'string' || !['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(frame.timeframe)
      || seen.has(frame.timeframe) || typeof frame.requested_bars !== 'number' || !Number.isSafeInteger(frame.requested_bars)
      || frame.requested_bars < 1 || frame.requested_bars > 1000 || !Array.isArray(market.candles[frame.timeframe])
      || frame.available_bars !== (market.candles[frame.timeframe] as unknown[]).length) return null
    seen.add(frame.timeframe)
    if (Number(frame.available_bars) < frame.requested_bars) partial = true
  }
  if (seen.size !== Object.keys(market.candles).length || value.status !== (partial ? 'partial' : 'complete')) return null
  if (market.indicators !== undefined) {
    if (!object(market.indicators)) return null
    for (const indicator of Object.values(market.indicators)) {
      if (!object(indicator) || typeof indicator.ready !== 'boolean') return null
      if (!indicator.ready) partial = true
    }
  }
  return partial ? 'partial' : 'complete'
}

export async function withPositionSizingContext(input: RiskEvaluationInput, reader?: ProposedDecisionEvidenceReader): Promise<RiskEvaluationInput> {
  input = structuredClone(input)
  if (!input.result.actions.some(action => Object.hasOwn(action.parameters, 'position_size_tier'))) return input
  delete input.positionSizingContext
  if (!reader) return input
  const evidence = await reader.read({ decisionId: input.decisionId, decisionRevision: input.decisionRevision,
    userId: input.policy.userId, accountId: input.policy.accountId, analysisRevision: input.currentRevisions.analysis })
  if (!evidence || evidence.decisionId !== input.decisionId || evidence.decisionRevision !== input.decisionRevision
    || evidence.userId !== input.policy.userId || evidence.accountId !== input.policy.accountId
    || evidence.analysisRevision !== input.currentRevisions.analysis || evidence.symbol !== input.instrument.symbol
    || evidence.decisionHash !== contentHash(input.result)) return input
  const completeness = coverage(evidence.market)
  if (!completeness) return input
  const evidenceCap = legacyPositionEvidenceCap(evidence.confidence, completeness)
  input.positionSizingContext = { decisionId: input.decisionId, decisionRevision: input.decisionRevision,
    userId: input.policy.userId, accountId: input.policy.accountId, policyHash: riskPolicyHash(input.policy),
    revisions: { ...input.currentRevisions },
    sourceEvidence: { snapshotId: evidence.snapshotId, snapshotHash: evidence.snapshotHash, decisionHash: evidence.decisionHash },
    // The verified legacy normalization path did not apply an add-position cap.
    // This flag denotes a policy operation, not a claim that no position exists.
    actions: input.result.actions.filter(action => Object.hasOwn(action.parameters, 'position_size_tier'))
      .map(action => ({ actionId: action.actionId, evidenceCap, applyAddCap: false })) }
  return input
}
