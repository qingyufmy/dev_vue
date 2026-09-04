import type { BridgeHistoryQueryClient } from '../../bridge/application/bridge-gateway-query-transport.js'
import type { BridgeGatewayRoute } from '../../bridge/domain/bridge-gateway.js'
import type { BridgeHistoryResource } from '../../bridge/domain/bridge-query.js'
import type { TradeHistoryCollectorRepository } from './trade-history-collector-ports.js'

export class TradeHistoryCollector {
  constructor(
    private readonly repository: TradeHistoryCollectorRepository,
    private readonly queries: BridgeHistoryQueryClient,
    private readonly now = () => new Date(),
  ) {}

  async collect(route: BridgeGatewayRoute) {
    const window = await this.repository.begin(route, this.now())
    try {
      if (route.timezoneOffsetMinutes === null) throw new Error('trade_history_timezone_unavailable')
      for (const resource of resources(route.platform)) await this.collectResource(route, resource, window)
      await this.repository.complete(route, window.rangeEndUtcMsc, this.now())
      return { status: 'ready' as const, freshThroughUtcMsc: window.rangeEndUtcMsc }
    } catch (error) {
      await this.repository.fail(route, publicCode(error), this.now())
      throw error
    }
  }

  private async collectResource(route: BridgeGatewayRoute, resource: BridgeHistoryResource, window: { rangeStartUtcMsc: number; rangeEndUtcMsc: number }) {
    let cursor: string | null = null
    const seen = new Set<string>()
    for (let page = 0; page < 2_000; page += 1) {
      const response = await this.queries.query({ route, resource, rangeStartUtcMsc: window.rangeStartUtcMsc,
        rangeEndUtcMsc: window.rangeEndUtcMsc, limit: 500, cursor, timeoutMs: 20_000 })
      await this.repository.persistPage(route, resource, response, this.now())
      if (!response.payload.has_more) return
      const next = response.payload.next_cursor
      if (!next || seen.has(next)) throw new Error('trade_history_cursor_loop')
      seen.add(next); cursor = next
    }
    throw new Error('trade_history_page_limit_exceeded')
  }
}

function resources(platform: BridgeGatewayRoute['platform']): BridgeHistoryResource[] {
  return platform === 'mt5' ? ['history.orders', 'history.deals'] : ['history.trades']
}
function publicCode(error: unknown) { const value = error instanceof Error ? error.message : 'trade_history_collection_failed'; return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'trade_history_collection_failed' }
