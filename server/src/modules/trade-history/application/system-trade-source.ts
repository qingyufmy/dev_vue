import type { TerminalDealFact } from '../domain/terminal-history-projection.js'

/** Consumer-owned lineage; execution adapters must prove each exact deal against immutable receipts. */
export interface SystemDealProof {
  dealTicket: string; orderTicket: string; commandId: string; intentId: string
  action: 'order.place' | 'position.close'; resultHash: string
  decisionId: string; riskDecisionId: string; strategyId: string; strategyVersionId: string
}
export type SystemTradeSource = { status: 'proven'; strategyId: string; strategyVersionId: string; proofs: SystemDealProof[] }
  | { status: 'unresolved'; reason: string }

/** Does not replace lifecycle/volume/currency/coverage checks. Never infers SL/TP or fees from the opening trade. */
export function resolveSystemTradeSource(facts: TerminalDealFact[], proofs: SystemDealProof[]): SystemTradeSource {
  const unresolved = (reason: string): SystemTradeSource => ({ status: 'unresolved', reason })
  if (!facts.length || facts.length > 1000 || new Set(facts.map(f => f.ticket)).size !== facts.length) return unresolved('system_trade_facts_invalid')
  const position = facts[0]!.positionId
  if (!position || facts.some(f => f.positionId !== position || f.dealKind !== 'trade'
    || !['in', 'out', 'out_by'].includes(f.entryKind))) return unresolved('system_trade_lifecycle_source_incomplete')
  if (!facts.some(f => f.entryKind === 'in') || !facts.some(f => f.entryKind === 'out' || f.entryKind === 'out_by')) return unresolved('system_trade_not_closed')
  const byDeal = new Map(proofs.map(p => [p.dealTicket, p]))
  if (byDeal.size !== proofs.length || proofs.length !== facts.length) return unresolved('system_trade_receipts_incomplete')
  for (const fact of facts) {
    const proof = byDeal.get(fact.ticket)
    if (!proof || proof.orderTicket !== fact.orderTicket
      || proof.action !== (fact.entryKind === 'in' ? 'order.place' : 'position.close')) return unresolved('system_trade_receipt_mismatch')
  }
  const versions = new Set(proofs.map(p => JSON.stringify([p.strategyId, p.strategyVersionId])))
  if (versions.size !== 1) return unresolved('system_trade_strategy_mixed')
  const first = proofs[0]!
  return { status: 'proven', strategyId: first.strategyId, strategyVersionId: first.strategyVersionId,
    proofs: facts.map(f => structuredClone(byDeal.get(f.ticket)!)) }
}
