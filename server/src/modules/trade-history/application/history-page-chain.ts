import { historyPageMember, historyPageChainSeed } from './history-page-membership.js'
import { assertQueryResultEnvelope, sameQueryRoute, type BridgeGatewayRoute, type BridgeHistoryResource, type BridgeQueryResponseEnvelope } from '../../bridge/index.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'
import type { TradeHistoryCollectionWindow, HistoryPageMember } from './trade-history-collector-ports.js'

/** Traversal evidence only; not a durable receipt or proof of terminal/cache coverage. */
export class HistoryPageChain {
  private readonly route: BridgeGatewayRoute
  private readonly window: TradeHistoryCollectionWindow
  private nextCursor: string | null = null
  private readonly cursors = new Set<string>()
  private revision: string | null = null
  private source: 'terminal' | 'local_projection' | null = null
  private coverageHash: string | null | undefined = undefined
  private historyCoverage: BridgeQueryResponseEnvelope['payload']['history_coverage']
  private members: HistoryPageMember[] | null = []
  private memberCount = 0
  private pageCount = 0
  private itemCount = 0
  private ended = false
  private digest: string

  constructor(route: BridgeGatewayRoute, window: TradeHistoryCollectionWindow, private readonly resource: BridgeHistoryResource) {
    this.route = structuredClone(route)
    this.window = structuredClone(window)
    if (!Number.isSafeInteger(window.rangeStartUtcMsc) || window.rangeStartUtcMsc < 1
      || !Number.isSafeInteger(window.rangeEndUtcMsc) || window.rangeEndUtcMsc <= window.rangeStartUtcMsc) throw Error('trade_history_window_invalid')
    this.digest = historyPageChainSeed(this.route, this.window, resource)
  }

  append(cursor: string | null, input: BridgeQueryResponseEnvelope) {
    const response = structuredClone(input)
    const checked = assertQueryResultEnvelope(response)
    if (checked.type !== 'query.response' || checked.payload.resource !== this.resource || !sameQueryRoute(checked.route, this.route)) throw Error('trade_history_page_scope_invalid')
    if (this.ended || cursor !== this.nextCursor || this.pageCount >= 2000) throw Error('trade_history_page_sequence_invalid')
    const payload = response.payload
    if (this.revision !== null && (payload.source_revision !== this.revision || payload.source !== this.source)) throw Error('trade_history_page_source_changed')
    if (payload.has_more && (!payload.next_cursor || payload.next_cursor === cursor || this.cursors.has(payload.next_cursor))) throw Error('trade_history_cursor_loop')
    const coverage = payload.history_coverage
    const coverageHash = coverage ? canonicalEvidence({ ...coverage }).hash : null
    if (coverage && (coverage.range_start_utc_msc !== this.window.rangeStartUtcMsc || coverage.range_end_utc_msc !== this.window.rangeEndUtcMsc)) throw Error('trade_history_coverage_window_invalid')
    if (this.coverageHash !== undefined && this.coverageHash !== coverageHash) throw Error('trade_history_coverage_changed')
    this.coverageHash = coverageHash
    this.historyCoverage = coverage ? structuredClone(coverage) : undefined
    if (this.members) {
      const member = historyPageMember(cursor, response)
      this.memberCount += member.factHashes.length
      if (this.memberCount > 10000) this.members = null
      else this.members.push(member)
    }
    this.revision = payload.source_revision
    this.source = payload.source
    this.digest = canonicalEvidence({ previousHash: this.digest, pageIndex: this.pageCount, requestedCursor: cursor,
      responseHash: canonicalEvidence(response as unknown as Record<string, unknown>).hash }).hash
    this.pageCount += 1
    this.itemCount += payload.items.length
    this.nextCursor = payload.next_cursor
    if (payload.next_cursor !== null) this.cursors.add(payload.next_cursor)
    this.ended = !payload.has_more
  }

  finish() {
    if (!this.ended || this.pageCount === 0) throw Error('trade_history_page_chain_incomplete')
    return { resource: this.resource, ...this.window, sourceRevision: this.revision!, source: this.source!,
      pageCount: this.pageCount, itemCount: this.itemCount, pageChainHash: this.digest,
      ...(this.members ? { pageMembership: { version: 1 as const, pages: structuredClone(this.members) } } : {}),
      ...(this.historyCoverage ? { historyCoverage: structuredClone(this.historyCoverage) } : {}) }
  }
}
