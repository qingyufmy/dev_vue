import type { PositionCreationInventory } from './reference-position-lifecycle.js'
import { InferenceError } from '../domain/inference.js'
import type { readReferencePositionCreation } from './reference-position-creation.js'
import type { TradeDecisionEntryAnalysis, TradeDecisionEntryAnalysisReader } from './trade-decision-entry-analysis-reader.js'

export type ReferencePositionEntryAnalyses = Array<
  | { ticket: string; status: 'unresolved'; reason: 'creation_decision_missing' | 'entry_analysis_unavailable' }
  | { ticket: string; status: 'read'; entries: Array<{ orderTicket: string; analysis: TradeDecisionEntryAnalysis }> }>

/** Retains every netting contribution. This neither chooses an entry timeframe nor authorizes management. */
export async function readReferencePositionEntryAnalyses(input: PositionCreationInventory,
  origins: Awaited<ReturnType<typeof readReferencePositionCreation>>, reader: TradeDecisionEntryAnalysisReader): Promise<ReferencePositionEntryAnalyses> {
  const inventory = structuredClone(input), creation = structuredClone(origins)
  const fail = (): never => { throw new InferenceError('reference_entry_analysis_invalid', 409) }
  if (inventory.positions.items.length > 1000) return fail()
  const positions = new Map(inventory.positions.items.map(item => [item.ticket, item]))
  if (positions.size !== inventory.positions.items.length) return fail()
  if (creation.status === 'unsupported_platform') return inventory.positions.items.map(item => ({ ticket: item.ticket, status: 'unresolved', reason: 'creation_decision_missing' }))
  if (creation.items.length !== positions.size || new Set(creation.items.map(item => item.ticket)).size !== positions.size) return fail()
  const cache = new Map<string, TradeDecisionEntryAnalysis | null>(), output: ReferencePositionEntryAnalyses = []
  for (const origin of creation.items) {
    const position = positions.get(origin.ticket)
    if (!position) return fail()
    if (origin.status !== 'creation_strategy_matched' || !origin.creationDecisions) {
      output.push({ ticket: origin.ticket, status: 'unresolved', reason: 'creation_decision_missing' }); continue
    }
    if (origin.creationDecisions.length === 0 || origin.creationDecisions.length !== origin.orderTickets.length
      || new Set(origin.creationDecisions.map(item => item.orderTicket)).size !== origin.orderTickets.length
      || origin.creationDecisions.some(item => !origin.orderTickets.includes(item.orderTicket))) return fail()
    const entries: Array<{ orderTicket: string; analysis: TradeDecisionEntryAnalysis }> = []
    for (const decision of origin.creationDecisions) {
      const scope = { decisionId: decision.decisionId, riskDecisionId: decision.riskDecisionId, strategyVersionId: decision.strategyVersionId,
        userId: inventory.authorization.operatorUserId, accountId: inventory.route.accountId, strategyId: origin.strategyId, symbol: position.symbol }
      const key = JSON.stringify(scope)
      if (!cache.has(key)) {
        if (cache.size >= 1000) return fail()
        cache.set(key, structuredClone(await reader.read(structuredClone(scope))))
      }
      const analysis = cache.get(key)
      if (!analysis) continue
      if (Object.entries(scope).some(([name, value]) => analysis[name as keyof typeof scope] !== value)) return fail()
      entries.push({ orderTicket: decision.orderTicket, analysis: structuredClone(analysis) })
    }
    output.push(entries.length === origin.creationDecisions.length ? { ticket: origin.ticket, status: 'read', entries }
      : { ticket: origin.ticket, status: 'unresolved', reason: 'entry_analysis_unavailable' })
  }
  return output
}
