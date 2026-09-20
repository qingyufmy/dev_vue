import type { Redis } from 'ioredis'
import { randomUUID } from 'node:crypto'
import { MarketHistoryBackfill, type MarketSourceSelector } from '../modules/market/index.js'
import { createMarketHistoryDemand } from '../modules/market/composition.js'
import type { TerminalFactRoute, MarketCandle } from '../modules/trading/index.js'
export function createMarketHistoryBackfill(cache: Redis, selector: MarketSourceSelector, catalog: { list(): Promise<string[]> },
  routes: { current(accountId: string): Promise<TerminalFactRoute | null> },
  io: { read(userId: number, accountId: string, symbol: string, timeframe: string, before: number, limit: number): Promise<{ items: MarketCandle[] }>; write(route: TerminalFactRoute, items: MarketCandle[]): Promise<void> },
  publish: (event: import('../modules/trading/index.js').BrowserRealtimeEvent) => Promise<unknown>) {
  const demands = createMarketHistoryDemand(cache)
  return new MarketHistoryBackfill({
    demands: async () => { const enabled = await catalog.list(); return (await demands.list()).filter(d => d.pool.kind !== 'public' || enabled.includes(d.symbol)) },
    select: scope => selector.select(scope), current: (scope, state) => selector.isCurrent(scope, state),
    progress: d => demands.progress(d), save: (d, p) => demands.save(d, p),
    collect: async (d, state, before, limit) => {
      const source = state.source!, route = await routes.current(source.accountId)
      if (!route || route.connectionId !== source.connectionId || route.connectionEpoch !== source.connectionEpoch || route.userId !== source.ownerUserId) throw new Error('market_history_route_changed')
      const result = await io.read(source.ownerUserId, source.accountId, state.resolvedSymbol!, d.timeframe, before, limit)
      if (!await selector.isCurrent(d, state) || (await routes.current(source.accountId))?.connectionId !== route.connectionId) throw new Error('market_history_route_changed')
      const items = result.items.filter(item => item.closed)
      if (items.some(item => item.symbol !== state.resolvedSymbol || item.timeframe !== d.timeframe)) throw new Error('market_history_scope_invalid')
      await io.write(route, items)
      return items.length
    },
    changed: async (d, state) => {
      if (d.pool.kind !== 'public' || !await selector.isCurrent(d, state)) return
      await publish({ eventId: randomUUID(), type: 'market.public.history.updated', occurredAt: new Date().toISOString(),
        userId: null, accountId: null, terminalInstanceId: null, resource: 'public_market', resourceId: `${d.symbol}:${d.timeframe}`,
        revision: Date.now(), data: { symbol: d.symbol, timeframe: d.timeframe } })
    },
  })
}
