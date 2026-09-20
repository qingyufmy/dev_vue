import { contentHash, InferenceError, type JsonObject } from '../domain/inference.js'
import type { ReferencePositionEntryAnalyses } from './reference-position-entry-analyses.js'
import type { ReferenceCreationDecision } from './reference-pending-creation.js'

export type ReferenceEntryEvidence =
  | { schemaVersion: 1; state: 'unavailable'; reason: 'not_collected' | 'creation_decision_missing' | 'entry_analysis_unavailable' | 'capacity_exceeded' }
  | { schemaVersion: 1; state: 'ready'; purpose: 'creation_analysis_only'; entries: JsonObject[]; evidenceHash: string }

const unavailable = (reason: Extract<ReferenceEntryEvidence, { state: 'unavailable' }>['reason']): ReferenceEntryEvidence => ({ schemaVersion: 1, state: 'unavailable', reason })

/** Bounded model projection. No terminal tickets, decision IDs, full prompts, or current-analysis fallback. */
export function projectReferenceEntryEvidence(input: {
  referenceId: string; userId: number; accountId: string; strategyId: string; symbol: string; asOf: string
  creationDecisions: Array<ReferenceCreationDecision & { orderTicket: string }> | null
  evidence: ReferencePositionEntryAnalyses[number] | undefined
}): ReferenceEntryEvidence {
  const value = structuredClone(input), fail = (): never => { throw new InferenceError('reference_entry_evidence_invalid', 409) }
  if (!value.evidence) return unavailable('not_collected')
  if (!value.creationDecisions) return unavailable('creation_decision_missing')
  if (value.evidence.status === 'unresolved') return unavailable(value.evidence.reason)
  const declarations = new Map(value.creationDecisions.map(item => [item.orderTicket, item]))
  if (declarations.size !== value.creationDecisions.length || declarations.size === 0
    || value.evidence.entries.length !== declarations.size || new Set(value.evidence.entries.map(item => item.orderTicket)).size !== declarations.size) return fail()
  if (declarations.size > 32) return unavailable('capacity_exceeded')
  const entries = value.evidence.entries.map(item => {
    const expected = declarations.get(item.orderTicket), analysis = item.analysis
    if (!expected || analysis.decisionId !== expected.decisionId || analysis.riskDecisionId !== expected.riskDecisionId
      || analysis.strategyVersionId !== expected.strategyVersionId || analysis.strategyId !== value.strategyId
      || analysis.accountId !== value.accountId || analysis.userId !== value.userId || analysis.symbol !== value.symbol
      || contentHash(analysis.result) !== analysis.analysisHash) return fail()
    if (![analysis.analysisHash, analysis.inputSnapshotHash, analysis.traderInputSnapshotHash].every(digest => /^[a-f0-9]{64}$/.test(digest))) return fail()
    const captured = Date.parse(analysis.inputCapturedAt), analyzed = Date.parse(analysis.result.analyzedAt), asOf = Date.parse(value.asOf)
    if (![captured, analyzed, asOf].every(Number.isFinite) || captured > analyzed || analyzed > asOf) return fail()
    const result: JsonObject = {
      referenceId: `entry:${contentHash({ position: value.referenceId, order: item.orderTicket, decision: expected.decisionId, risk: expected.riskDecisionId })}`,
      traderStrategyVersionId: analysis.strategyVersionId, analysisStrategyId: analysis.analysisStrategyId,
      analysisStrategyVersionId: analysis.analysisStrategyVersionId, analysisHash: analysis.analysisHash,
      inputSnapshotHash: analysis.inputSnapshotHash, traderInputSnapshotHash: analysis.traderInputSnapshotHash,
      inputCapturedAt: analysis.inputCapturedAt, analyzedAt: analysis.result.analyzedAt, validUntil: analysis.result.validUntil,
      marketBias: analysis.result.marketBias, marketRegime: analysis.result.marketRegime,
      keyLevels: analysis.result.keyLevels, invalidation: analysis.result.invalidation, dataGaps: analysis.result.dataGaps,
    }
    return result
  }).sort((a, b) => String(a.referenceId).localeCompare(String(b.referenceId)))
  // Never silently drop one contribution or truncate a condition into a different meaning.
  if (Buffer.byteLength(JSON.stringify(entries)) > 32 * 1024) return unavailable('capacity_exceeded')
  return { schemaVersion: 1, state: 'ready', purpose: 'creation_analysis_only', entries, evidenceHash: contentHash(entries) }
}

/** Validate the provider projection again at the final snapshot boundary. */
export function freezeReferenceEntryEvidence(value: ReferenceEntryEvidence): JsonObject {
  const copy = structuredClone(value), fail = (): never => { throw new InferenceError('reference_entry_evidence_invalid', 409) }
  if (copy.schemaVersion !== 1) return fail()
  if (copy.state === 'unavailable') {
    if (!['not_collected', 'creation_decision_missing', 'entry_analysis_unavailable', 'capacity_exceeded'].includes(copy.reason)) return fail()
    return { schemaVersion: 1, state: 'unavailable', reason: copy.reason }
  }
  const fields = ['referenceId','traderStrategyVersionId','analysisStrategyId','analysisStrategyVersionId','analysisHash','inputSnapshotHash',
    'traderInputSnapshotHash','inputCapturedAt','analyzedAt','validUntil','marketBias','marketRegime','keyLevels','invalidation','dataGaps']
  const object = (item: unknown): item is JsonObject => item !== null && typeof item === 'object' && !Array.isArray(item)
  const identifier = (item: unknown) => typeof item === 'string' && /^[1-9]\d{0,19}$/.test(item) && BigInt(item) <= 18446744073709551615n
  const utc = (item: unknown) => typeof item === 'string' && Number.isFinite(Date.parse(item)) && new Date(item).toISOString() === item
  if (copy.state !== 'ready' || copy.purpose !== 'creation_analysis_only' || !Array.isArray(copy.entries) || copy.entries.length === 0
    || copy.entries.length > 32 || copy.entries.some(item => !object(item)) || new Set(copy.entries.map(item => item.referenceId)).size !== copy.entries.length
    || copy.entries.some(item => typeof item.referenceId !== 'string' || !/^entry:[a-f0-9]{64}$/.test(item.referenceId))
    || copy.entries.some(item => Object.keys(item).length !== fields.length || Object.keys(item).some(key => !fields.includes(key))
      || ![item.traderStrategyVersionId,item.analysisStrategyId,item.analysisStrategyVersionId].every(identifier)
      || ![item.analysisHash,item.inputSnapshotHash,item.traderInputSnapshotHash].every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
      || ![item.inputCapturedAt,item.analyzedAt,item.validUntil].every(utc)
      || !['bullish','bearish','neutral','uncertain'].includes(String(item.marketBias)) || typeof item.marketRegime !== 'string'
      || !object(item.keyLevels) || !object(item.invalidation) || !Array.isArray(item.dataGaps) || item.dataGaps.some(gap => typeof gap !== 'string'))
    || Buffer.byteLength(JSON.stringify(copy.entries)) > 32 * 1024 || contentHash(copy.entries) !== copy.evidenceHash) return fail()
  return { schemaVersion: 1, state: 'ready', purpose: 'creation_analysis_only', entries: copy.entries, evidenceHash: copy.evidenceHash }
}
