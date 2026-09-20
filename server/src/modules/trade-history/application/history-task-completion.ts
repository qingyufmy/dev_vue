import { assertHistoryPageMembership } from './history-page-membership.js'
import { validHistoryQueryCoverage, type BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryResourcePageChain } from './trade-history-collector-ports.js'
import { freezeHistoryCollectionClaim, freezeHistoryCollectionRequest, historyTaskRoute, type HistoryCollectionClaim, type HistoryCollectionRequest } from './history-collection-task.js'
import { historyCollectionReceipt } from './history-collection-receipt.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

export function historyTaskCompletion(input: HistoryCollectionClaim, route: BridgeGatewayRoute, chains: readonly HistoryResourcePageChain[]) {
  const claim = freezeHistoryCollectionClaim(input)
  return historyTaskCompletionEvidence(claim, claim.routeHash, route, chains)
}

/** Lease-independent evidence reconstruction for completed-task readers. Grants no mutation rights. */
export function historyTaskCompletionEvidence(input: HistoryCollectionRequest, routeHash: string, route: BridgeGatewayRoute, chains: readonly HistoryResourcePageChain[]) {
  const claim = { ...freezeHistoryCollectionRequest(input), routeHash }, identity = historyTaskRoute(route)
  if (claim.accountId !== identity.value.accountId || claim.routeHash !== identity.hash) throw Error('history_task_claim_mismatch')
  const pageChains = structuredClone([...chains]).sort((a, b) => a.resource.localeCompare(b.resource))
  for (const chain of pageChains) {
    assertHistoryPageMembership(route, chain)
    if (!Object.hasOwn(chain, 'historyCoverage')) continue
    const coverage = chain.historyCoverage
    if (!coverage || !validHistoryQueryCoverage(coverage, chain.resource, chain.sourceRevision, coverage.collected_at_utc_msc)
      || coverage.range_start_utc_msc !== claim.rangeStartUtcMsc || coverage.range_end_utc_msc !== claim.rangeEndUtcMsc) {
      throw Error('history_task_coverage_invalid')
    }
  }
  const receipt = historyCollectionReceipt(route, claim.rangeEndUtcMsc, pageChains)
  if (receipt.evidence.rangeStartUtcMsc !== claim.rangeStartUtcMsc) throw Error('history_task_window_mismatch')
  const value = { version: 1, taskId: claim.taskId, accountId: claim.accountId, routeHash: claim.routeHash,
    rangeStartUtcMsc: claim.rangeStartUtcMsc, rangeEndUtcMsc: claim.rangeEndUtcMsc, receiptHash: receipt.hash, pageChains }
  return { value, ...canonicalEvidence(value) }
}

/** Rebuild rather than trusting JSON casts, including after a new lease takes over. */
export function restoreHistoryTaskCompletion(claim: HistoryCollectionClaim, route: BridgeGatewayRoute, json: unknown, digest: unknown) {
  try {
    const raw: unknown = typeof json === 'string' ? JSON.parse(json) : structuredClone(json)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw Error('invalid')
    const record = raw as Record<string, unknown>
    if (!Array.isArray(record.pageChains)) throw Error('invalid')
    const rebuilt = historyTaskCompletion(claim, route, record.pageChains as HistoryResourcePageChain[])
    if (rebuilt.hash !== digest || canonicalEvidence(record).hash !== digest) throw Error('invalid')
    return rebuilt
  } catch { throw Error('history_task_completion_corrupt') }
}
