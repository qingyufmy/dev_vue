import type { BridgeHistoryQueryClient, BridgeGatewayRoute, BridgeHistoryResource, BridgeQueryResponseEnvelope } from '../../bridge/index.js'
import type { HistoryResourcePageChain, TradeHistoryCollectorRepository } from './trade-history-collector-ports.js'
import { HistoryPageChain } from './history-page-chain.js'
import { HistoryCommitUnknown } from './history-commit-unknown.js'

export class TradeHistoryCollector {
  constructor(
    private readonly repository: TradeHistoryCollectorRepository,
    private readonly queries: BridgeHistoryQueryClient,
    private readonly now = () => new Date(),
    private readonly wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
  ) {}

  async collect(route: BridgeGatewayRoute) {
    route = structuredClone(route)
    const window = structuredClone(await this.repository.begin(structuredClone(route), this.now()))
    try {
      if (route.timezoneOffsetMinutes === null) throw new Error('trade_history_timezone_unavailable')
      const pageChains: HistoryResourcePageChain[] = []
      for (const resource of resources(route.platform)) pageChains.push(await this.collectResource(route, resource, window))
      const complete = () => this.repository.complete(structuredClone(route), window.rangeEndUtcMsc, this.now(), structuredClone(pageChains))
      try { await complete() } catch (error) {
        if (!(error instanceof HistoryCommitUnknown)) throw error
        // Same evidence only: the durable receipt makes this confirmation idempotent.
        try { await complete() } catch { throw new HistoryCommitUnknown() }
      }
      return { status: 'ready' as const, freshThroughUtcMsc: window.rangeEndUtcMsc, pageChains }
    } catch (error) {
      if (!(error instanceof HistoryCommitUnknown)) await this.repository.fail(route, publicCode(error), this.now())
      throw error
    }
  }

  private async collectResource(route: BridgeGatewayRoute, resource: BridgeHistoryResource, window: { rangeStartUtcMsc: number; rangeEndUtcMsc: number }) {
    let cursor: string | null = null
    const chain = new HistoryPageChain(route, window, resource)
    for (let page = 0; page < 2_000; page += 1) {
      const response: BridgeQueryResponseEnvelope = structuredClone(await this.readPage(route, resource, window, cursor))
      chain.append(cursor, response)
      const next: string | null = response.payload.next_cursor
      await this.repository.persistPage(structuredClone(route), resource, structuredClone(response), this.now())
      if (!response.payload.has_more) return chain.finish()
      cursor = next
    }
    throw new Error('trade_history_page_limit_exceeded')
  }

  private async readPage(route: BridgeGatewayRoute, resource: BridgeHistoryResource,
    window: { rangeStartUtcMsc: number; rangeEndUtcMsc: number }, cursor: string | null) {
    // The bridge fills its local cache asynchronously. Keep the exact window/cursor while it does so.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.queries.query({ route: structuredClone(route), resource, ...window, limit: 500, cursor, timeoutMs: 20_000 })
      } catch (error) {
        if (!(error instanceof Error) || !['bridge_projection_refreshing', 'bridge_query_inflight'].includes(error.message) || attempt >= 5) throw error
        await this.wait(1000 * 2 ** attempt)
      }
    }
  }
}

function resources(platform: BridgeGatewayRoute['platform']): BridgeHistoryResource[] {
  return platform === 'mt5' ? ['history.orders', 'history.deals'] : ['history.trades']
}
function publicCode(error: unknown) { const value = error instanceof Error ? error.message : 'trade_history_collection_failed'; return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'trade_history_collection_failed' }
