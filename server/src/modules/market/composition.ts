import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import { RedisMarketHistoryDemand } from './infrastructure/redis-market-history-demand.js'
export function createMarketHistoryDemand(cache: Redis) { return new RedisMarketHistoryDemand(cache) }
import { PublicMarketSnapshot } from './application/public-market-snapshot.js'
import { PublicMarketRelay, type PublicMarketEvent } from './application/public-market-relay.js'
export function createPublicMarketRelay(pool: Pool, providers: { list(): Promise<number[]> }, trading: PublicMarketCache,
  catalog: { list(): Promise<string[]> }, publish: (event: PublicMarketEvent) => Promise<unknown>, failed: () => void) {
  const sources = new MysqlMarketSourceStore(pool)
  return new PublicMarketRelay(catalog, sources, new PublicMarketSnapshot(providers, trading, catalog), publish, failed)
}
import { publicMarketRoutes } from './transport/http/public-market-routes.js'
import type { PublicMarketCache } from './application/public-market-snapshot.js'
export function createPublicMarketHttp(pool: Pool, providers: { list(): Promise<number[]> }, trading: PublicMarketCache, auth: CalendarHttpAuth, catalog: { list(): Promise<string[]> }, demand?: { use(scope: import('./domain/market-source.js').MarketSourceScope): Promise<void> }): FastifyPluginAsync {
  return async app => {
    await app.register(publicMarketRoutes, { prefix: '/api/v4', auth, service: new PublicMarketSnapshot(providers, trading, catalog, demand, new MysqlMarketSourceStore(pool)) })
  }
}
import { MarketSourceSelector } from './application/market-source-selector.js'
import { AutomaticMarketSessionGate } from './application/automatic-market-session-gate.js'
import type { MarketStrategyAccess } from './application/market-source-access.js'
import { MysqlMarketSourceStore } from './infrastructure/mysql-market-source-store.js'
import type { MarketSourceCandidates } from './application/market-source-ports.js'
export function createMarketSourceSelector(pool: Pool, candidates: MarketSourceCandidates) {
  return new MarketSourceSelector(new MysqlMarketSourceStore(pool), candidates)
}
export function createAutomaticMarketSessionGate(pool: Pool, strategies: MarketStrategyAccess) {
  return new AutomaticMarketSessionGate(strategies, new MysqlMarketSourceStore(pool))
}
import type { FastifyPluginAsync } from 'fastify'
import { CalendarService } from './application/calendar-service.js'
import { MysqlCalendarReader } from './infrastructure/mysql-calendar-reader.js'
import { calendarRoutes, type CalendarHttpAuth } from './transport/http/calendar-routes.js'
import { MacroSeriesService } from './application/macro-series-service.js'
import { MysqlMacroSeriesReader } from './infrastructure/mysql-macro-series-reader.js'
import { MacroFreshnessPolicy } from './domain/macro-freshness.js'
import { macroSeriesRoutes } from './transport/http/macro-series-routes.js'
import { MacroSnapshotService } from './application/macro-snapshot-service.js'
import { MysqlPublicMacroSnapshotReader } from './infrastructure/mysql-public-macro-snapshot-reader.js'
import { macroSnapshotRoutes } from './transport/http/macro-snapshot-routes.js'

export function createCalendarService(executor: Pick<Pool, 'execute'>) { return new CalendarService(new MysqlCalendarReader(executor)) }
export function createMacroSeriesService(executor: Pick<Pool, 'execute'>) {
  return new MacroSeriesService(new MysqlMacroSeriesReader(executor), new MacroFreshnessPolicy())
}
export function createMacroSnapshotService(executor: Pick<Pool, 'execute'>, calendar: CalendarService) {
  return new MacroSnapshotService(new MysqlPublicMacroSnapshotReader(executor), calendar)
}
export function createMarketHttp(calendar: CalendarService, auth: CalendarHttpAuth, series: MacroSeriesService, snapshots: MacroSnapshotService): FastifyPluginAsync {
  return async app => {
    await app.register(calendarRoutes, { prefix: '/api/v4', service: calendar, auth })
    await app.register(macroSeriesRoutes, { prefix: '/api/v4', service: series, auth })
    await app.register(macroSnapshotRoutes, { prefix: '/api/v4', service: snapshots, auth })
  }
}
export { assertMarketSourceSchemaReady } from './infrastructure/mysql-market-source-schema.js'
