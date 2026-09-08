import Fastify from 'fastify'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4BaseRuntimeConfig, loadV4BrowserRealtimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import { createRealtimeTicketAuthenticator } from '../modules/auth/composition.js'
import { RedisBridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import {
  BrowserRealtimeHub, MysqlTradingRepository, MysqlObserverAccessReader, RedisBrowserRealtimeSubscriber,
} from '../modules/trading/index.js'
import { BrowserRealtimeWebSocketServer } from '../transport/browser-realtime-websocket-server.js'

loadServerEnvironment()

async function main() {
  const runtime = loadV4BaseRuntimeConfig()
  const web = loadV4BrowserRealtimeConfig()
  assertV4RuntimeEnabled(runtime)
  const health = new RoleHealth('browser-realtime')
  const pool = createMysqlPool(runtime.mysql)
  const ticketCache = createCacheRedis(runtime.cacheRedis)
  const eventCache = createCacheRedis(runtime.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(ticketCache), connectCacheRedis(eventCache)])

  const observerAccess = new MysqlObserverAccessReader(pool)
  const tradingRepository = new MysqlTradingRepository(pool, new RedisBridgeGatewayLeaseStore(ticketCache), observerAccess)
  const hub = new BrowserRealtimeHub(tradingRepository, observerAccess)
  const events = new RedisBrowserRealtimeSubscriber(eventCache, {
    publish(event) { hub.publish(event); health.workSucceeded() },
    invalidateObserverAuthorization(control) { hub.invalidateObserverAuthorization(control); health.workSucceeded() },
  }, undefined, code => health.workFailed(code))
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024, trustProxy: true })
  const webSockets = new BrowserRealtimeWebSocketServer(
    app.server,
    createRealtimeTicketAuthenticator(pool, ticketCache),
    hub,
    web.tradeOrigin,
    web.secureCookies,
  )
  app.get('/health/live', async () => ({ status: 'ok', ...health.snapshot(), connections: webSockets.connectionCount() }))
  app.get('/health/ready', async (_request, reply) => {
    const dependencies = await dependenciesReady(pool, ticketCache, eventCache)
    const snapshot = health.snapshot()
    const ready = dependencies && snapshot.accepting && snapshot.ready
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready', ...snapshot,
      dependencies_ready: dependencies, connections: webSockets.connectionCount() })
  })

  await events.start()
  webSockets.start()
  await app.listen({ host: runtime.host, port: web.port })
  health.setReady(true)
  health.setAccepting(true)

  installProcessLifecycle('browser-realtime', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await webSockets.close()
    await events.close()
    await app.close()
    await Promise.allSettled([eventCache.quit(), ticketCache.quit(), pool.end()])
  })
}

async function dependenciesReady(
  pool: ReturnType<typeof createMysqlPool>,
  ticketCache: ReturnType<typeof createCacheRedis>,
  eventCache: ReturnType<typeof createCacheRedis>,
) {
  try {
    await Promise.all([pool.query('SELECT 1'), ticketCache.ping(), eventCache.ping()])
    return true
  } catch { return false }
}

void main().catch(error => {
  console.error('[browser-realtime] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
