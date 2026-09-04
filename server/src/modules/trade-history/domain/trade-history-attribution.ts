import type { TradeAttributionStatus, TradeHistorySource } from './trade-history.js'

export type ProvenTradeSource = Exclude<TradeHistorySource, 'mixed' | 'unknown'>
export type TradeLifecycleRelation = 'opened' | 'modified' | 'closed' | 'cancelled'

export interface TradeSourceProof {
  source: ProvenTradeSource
  relation: TradeLifecycleRelation
  exact: boolean
}

export interface TradeAttributionResult {
  source: TradeHistorySource
  status: TradeAttributionStatus
  provenSources: ProvenTradeSource[]
}

/**
 * Classifies only explicit terminal-ticket/deal or execution-ledger proofs.
 * Magic numbers and free-form comments can be retained as evidence, but must not
 * be promoted into an exact source without a separately reconciled mapping.
 */
export function classifyTradeAttribution(proofs: TradeSourceProof[]): TradeAttributionResult {
  const exactSources = ordered(proofs.filter((proof) => proof.exact).map((proof) => proof.source))
  const unprovenSources = ordered(proofs.filter((proof) => !proof.exact).map((proof) => proof.source))

  if (!exactSources.length) return { source: 'unknown', status: 'unresolved', provenSources: [] }
  if (exactSources.length > 1) return { source: 'mixed', status: 'exact', provenSources: exactSources }
  if (unprovenSources.some((source) => source !== exactSources[0])) {
    return { source: exactSources[0]!, status: 'partial', provenSources: exactSources }
  }
  return { source: exactSources[0]!, status: 'exact', provenSources: exactSources }
}

function ordered(values: ProvenTradeSource[]) {
  return [...new Set(values)].sort((left, right) => ['system', 'manual', 'other_ea'].indexOf(left) - ['system', 'manual', 'other_ea'].indexOf(right))
}
