import { createBridgeGatewayLeases } from '../modules/bridge/composition.js'
import { assertAccountPrincipalReadSchemaV2, createAccountPrincipalReader } from '../modules/auth/composition.js'
import Fastify from 'fastify'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4BaseRuntimeConfig, loadV4BrowserRealtimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import { createRealtimeTicketAuthenticator } from '../modules/auth/composition.js'

import { assertTradingSchemaReady, createBrowserTradingModule } from '../modules/trading/composition.js'
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
  await Promise.all([assertTradingSchemaReady(pool, assertAccountPrincipalReadSchemaV2), connectCacheRedis(ticketCache), connectCacheRedis(eventCache)])

  const { sessions, events } = createBrowserTradingModule(pool, createBridgeGatewayLeases(ticketCache), eventCache,
    () => health.workSucceeded(), code => health.workFailed(code), createAccountPrincipalReader, ticketCache)
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024, trustProxy: true })
  const webSockets = new BrowserRealtimeWebSocketServer(
    app.server,
    createRealtimeTicketAuthenticator(pool, ticketCache),
    sessions,
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
    await Promise.all([assertTradingSchemaReady(pool, assertAccountPrincipalReadSchemaV2), ticketCache.ping(), eventCache.ping()])
    return true
  } catch { return false }
}

void main().catch(error => {
  console.error('[browser-realtime] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
