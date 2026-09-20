import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryTaskDealInventoryReader } from './history-task-deal-inventory-reader.js'
import type { ReviewTradeEvidenceReader, ReviewTradeEvidence } from './review-trade-evidence-reader.js'
import { decodeTerminalHistoryPage } from '../domain/terminal-history-projection.js'
import { TradeHistoryError } from '../domain/trade-history.js'

export type ReviewTradeReadiness = { status: 'ready_as_of'; evidence: ReviewTradeEvidence; asOfUtcMsc: number;
  taskId: string; receiptId: string; completionHash: string }
  | { status: 'unresolved'; reason: string }
export interface ReviewTradeReadinessReader {
  read(input: { userId: number; recordId: string; expectedRevision: number; taskId: string;
    route: BridgeGatewayRoute; asOfUtcMsc: number }): Promise<ReviewTradeReadiness>
}

/** Combines one authorized transaction's record and full task inventory. Later corrections require new evidence. */
export function createReviewTradeReadinessReader(trades: ReviewTradeEvidenceReader,
  inventory: HistoryTaskDealInventoryReader, now = () => Date.now()): ReviewTradeReadinessReader {
  return { async read(input) {
    const scope = structuredClone(input)
    if (scope.route.userId !== scope.userId || !Number.isSafeInteger(scope.asOfUtcMsc) || scope.asOfUtcMsc <= 0
      || scope.asOfUtcMsc > now()) throw new TradeHistoryError('review_trade_readiness_scope_invalid', 422)
    const captured = await trades.read({ userId: scope.userId, recordId: scope.recordId, expectedRevision: scope.expectedRevision })
    if (captured.status !== 'captured') return captured
    const evidence = captured.evidence
    if (evidence.userId !== scope.userId || evidence.accountId !== scope.route.accountId || evidence.platform !== scope.route.platform
      || evidence.recordId !== scope.recordId || evidence.revision !== scope.expectedRevision) throw new TradeHistoryError('review_trade_readiness_scope_invalid', 409)
    if (Date.parse(evidence.closedAt) > scope.asOfUtcMsc) return { status: 'unresolved', reason: 'trade_not_closed_at_cutoff' }
    const result = await inventory.read({ taskId: scope.taskId, route: scope.route })
    if (result.status !== 'inventory_matched') return result
    if (result.taskId !== scope.taskId || result.rangeStartUtcMsc > Date.parse(evidence.openedAt) || result.rangeEndUtcMsc < scope.asOfUtcMsc) {
      return { status: 'unresolved', reason: 'collection_window_incomplete' }
    }
    if (evidence.platform !== 'mt5' || !evidence.projection.positionId) return { status: 'unresolved', reason: 'unsupported_platform' }
    const matching = result.facts.filter(fact => {
      const decoded = decodeTerminalHistoryPage('deals', [fact.raw])[0]
      return decoded?.kind === 'deal' && decoded.positionId === evidence.projection.positionId && decoded.occurredAtUtcMsc <= scope.asOfUtcMsc
    })
    const key = (fact: { id: string; ticket: string; hash: string }) => JSON.stringify([fact.id, fact.ticket, fact.hash])
    const expected = new Set(evidence.facts.map(key)), actual = new Set(matching.map(key))
    if (!expected.size || expected.size !== evidence.facts.length || actual.size !== matching.length
      || expected.size !== actual.size || [...expected].some(value => !actual.has(value))) {
      return { status: 'unresolved', reason: 'trade_inventory_mismatch' }
    }
    return { status: 'ready_as_of', evidence, asOfUtcMsc: scope.asOfUtcMsc,
      taskId: result.taskId, receiptId: result.receiptId, completionHash: result.completionHash }
  } }
}
