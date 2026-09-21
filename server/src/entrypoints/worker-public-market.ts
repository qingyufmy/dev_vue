import { MarketGapConfirmations } from '../bootstrap/market-gap-confirmation-runtime.js'
import { createMarketHistoryBackfill } from '../bootstrap/market-history-backfill-runtime.js'
import { assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4BaseRuntimeConfig, RoleHealth, startRoleHealthServer } from '../bootstrap/index.js'
import { createAccountPrincipalReader, createMysqlMarketProviders, assertAccountPrincipalReadSchemaV2 } from '../modules/auth/composition.js'
import { createBridgeGatewayLeases } from '../modules/bridge/composition.js'
import { PublicMarketCatalog, PublicMarketCollector } from '../modules/market/index.js'
import { assertMarketSourceSchemaReady, createMarketSourceSelector, createPublicMarketRelay } from '../modules/market/composition.js'
import { createMarketHistoryIO } from '../modules/trading/composition.js'
import { createSettingReader } from '../modules/settings/composition.js'
import { assertTradingSchemaReady, createBridgeMarketSourceCandidates, createMarketStreamDemands, createTradingReader, createPublicMarketEventTransport } from '../modules/trading/composition.js'

loadServerEnvironment()

async function main() {
  const config = loadV4BaseRuntimeConfig()
  assertV4RuntimeEnabled(config)
  const port = Number(process.env.V4_PUBLIC_MARKET_HEALTH_PORT ?? 3029)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('public_market_health_port_invalid')
  const health = new RoleHealth('worker-public-market')
  const pool = createMysqlPool(config.mysql), cache = createCacheRedis(config.cacheRedis)
  await Promise.all([connectCacheRedis(cache), assertTradingSchemaReady(pool, assertAccountPrincipalReadSchemaV2), assertMarketSourceSchemaReady(pool)])
  const routes = createBridgeGatewayLeases(cache)
  const catalog = new PublicMarketCatalog(createSettingReader(pool))
  await catalog.list()
  const selector = createMarketSourceSelector(pool, createBridgeMarketSourceCandidates(
    createTradingReader(pool, routes, createAccountPrincipalReader), createMysqlMarketProviders(pool), routes, cache))
  const collector = new PublicMarketCollector(catalog, selector, createMarketStreamDemands(cache, code => health.workFailed(code)))
  const eventCache = createCacheRedis(config.cacheRedis)
  await connectCacheRedis(eventCache)
  const events = createPublicMarketEventTransport(eventCache, cache, event => relay.accept(event), code => health.workFailed(code))
  const relay = createPublicMarketRelay(pool, createMysqlMarketProviders(pool), createTradingReader(pool, routes, createAccountPrincipalReader), catalog,
    event => events.publish(event), () => health.workFailed('public_market_relay_failed'))
  await events.start()
  const history = createMarketHistoryBackfill(cache, selector, catalog, routes,
    createMarketHistoryIO(pool, cache, createTradingReader(pool, routes, createAccountPrincipalReader)), event => events.publish(event))
  const gapConfirmations = new MarketGapConfirmations(cache)
  const gapIO = createMarketHistoryIO(pool, cache, createTradingReader(pool, routes, createAccountPrincipalReader))
  const historyLoop = new AsyncPollLoop(async () => {
    try {
      await history.tick()
      // Keep Bridge reads serial, but drain a bounded batch so the analysis that
      // discovered the gaps can observe the terminal confirmation before freezing.
      for (let index = 0; index < 8; index++) {
        if (!await gapConfirmations.tick(selector, routes, gapIO)) break
      }
    } catch (error) {
      health.workFailed('market_history_backfill_failed')
      const message = error instanceof Error ? error.message : ''
      console.warn('[market-history]', /^[a-z0-9_]{3,100}$/.test(message) ? message : 'market_history_backfill_failed')
    }
  }, 1000)
  const loop = new AsyncPollLoop(async () => {
    try {
      const result = await collector.tick()
      if (result.failed.length) health.workFailed('public_market_collection_partial_failure')
      else health.workSucceeded()
    } catch { health.workFailed('public_market_collection_failed') }
  }, 5000)
  const server = await startRoleHealthServer({ host: config.host, port, health,
    dependencyReady: async () => { try { await Promise.all([catalog.list(), cache.ping()]); return true } catch { return false } } })
  loop.start()
  historyLoop.start()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('worker-public-market', async () => {
    health.setAccepting(false)
    collector.close()
    history.close()
    await historyLoop.stop()
    await events.close()
    await relay.close()
    await loop.stop()
    await closeHttpServer(server)
    await Promise.allSettled([cache.quit(), eventCache.quit(), pool.end()])
  })
}

void main().catch(() => { console.error('[worker-public-market] startup failed'); process.exit(1) })
