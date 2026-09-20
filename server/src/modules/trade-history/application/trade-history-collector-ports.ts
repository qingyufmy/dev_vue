export interface HistoryPageMember {
  requestedCursor: string | null
  responseHash: string
  requestId: string
  queryMessageId: string | null
  responseMessageId: string
  itemCount: number
  factHashes: string[]
}
export interface HistoryPageMembership { version: 1; pages: HistoryPageMember[] }
import type { BridgeGatewayRoute, BridgeHistoryResource, BridgeQueryResponseEnvelope } from '../../bridge/index.js'

export interface TradeHistoryCollectionWindow { rangeStartUtcMsc: number; rangeEndUtcMsc: number }
export interface HistoryResourcePageChain extends TradeHistoryCollectionWindow {
  resource: BridgeHistoryResource
  sourceRevision: string
  source: 'terminal' | 'local_projection'
  pageCount: number
  itemCount: number
  pageChainHash: string
  pageMembership?: HistoryPageMembership
  historyCoverage?: NonNullable<BridgeQueryResponseEnvelope['payload']['history_coverage']>
}

export interface TradeHistoryCollectorRepository {
  begin(route: BridgeGatewayRoute, now: Date): Promise<TradeHistoryCollectionWindow>
  persistPage(route: BridgeGatewayRoute, resource: BridgeHistoryResource, response: BridgeQueryResponseEnvelope, now: Date): Promise<void>
  complete(route: BridgeGatewayRoute, freshThroughUtcMsc: number, now: Date, pageChains: readonly HistoryResourcePageChain[]): Promise<void>
  fail(route: BridgeGatewayRoute, code: string, now: Date): Promise<void>
}

export interface TradeHistoryScheduleRepository {
  scheduleDue(limit: number, now: Date): Promise<string[]>
}
