import { assertMysqlInstrumentCollectionSchemaReady, createTransactionTerminalFactRouteGuard, createTransactionAccountClock } from '../modules/trading/composition.js'
import { RedisBridgeMarketReadSubscriber, RedisBridgeMarketDemandSubscriber, createBridgeGatewayLeases, createBridgeSessionTickets } from '../modules/bridge/composition.js'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createProjectionReservationAbsorber } from '../modules/execution/composition.js'
import Fastify from 'fastify'
import { Worker } from 'bullmq'
import { createBridgeCommandProcessor } from '../queue/bridge-command-processor.js'
import { createBridgeHistoryTaskProcessor } from '../queue/bridge-history-task-processor.js'
import { createBridgeInstrumentProcessor } from '../queue/bridge-instrument-processor.js'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import { createPositionProtectionCommandRuntime } from '../bootstrap/position-protection-command-runtime.js'
import { BridgeGatewayCommandTransport, BridgeGatewayService, BridgeTradeProjectionDecoder, BridgeV4StreamIngestor, BridgeGatewayQueryTransport, InProcessBridgeGatewayDirectory, BridgeInstrumentCollector, BridgeInstrumentWorker } from '../modules/bridge/index.js'
import { createBridgeGatewayRoutes, assertMysqlBridgeInstallationSchemaReady } from '../modules/bridge/composition.js'
import { createAccountRegistration, createBridgeTradingModule, createMysqlInstrumentCollectionTasks, createMysqlInstrumentSnapshotReader, createInstrumentProjectionWriter } from '../modules/trading/composition.js'
import { createMysqlHistoryTaskWorker, assertMysqlHistoryTaskSchemaReady } from '../modules/trade-history/composition.js'
import { BRIDGE_DISPATCH_QUEUE, BRIDGE_HISTORY_TASK_QUEUE, BRIDGE_INSTRUMENT_QUEUE, type BridgeCommandJob, type BridgeHistoryTaskJob, type BridgeInstrumentJob } from '../queue/task-queues.js'
import { BridgeV4WebSocketServer } from '../transport/bridge-v4-websocket-server.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('bridge-gateway')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  const marketCache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache), connectCacheRedis(marketCache)])
  await assertMysqlInstrumentCollectionSchemaReady(pool)
  await assertMysqlHistoryTaskSchemaReady(pool)
  await assertMysqlBridgeInstallationSchemaReady(pool)

  const leases = createBridgeGatewayLeases(cache)
  const { capacity, projector } = createBridgeTradingModule(pool, cache, leases, error => {
    console.error('[bridge-gateway] realtime publish failed', safeError(error))
  }, createProjectionReservationAbsorber)
  const streams = new BridgeV4StreamIngestor(new BridgeTradeProjectionDecoder(), projector)
  const directory = new InProcessBridgeGatewayDirectory()
  const routes = createBridgeGatewayRoutes(pool, connection => createAccountRegistration(connection, createActivePrincipalAccess(connection)))
  const marketDemands = new RedisBridgeMarketDemandSubscriber(marketCache, leases, routes, directory, code => console.error(code))
  const transport = new BridgeGatewayCommandTransport(leases, directory, routes)
  const queries = new BridgeGatewayQueryTransport(leases, directory, routes)
  const marketReads = new RedisBridgeMarketReadSubscriber(marketCache, cache, leases, queries)
  const historyTasks = createMysqlHistoryTaskWorker(pool, queries, leases, createTransactionTerminalFactRouteGuard, {
    async read(userId, accountId) {
      const connection = await pool.getConnection()
      try { return await createTransactionAccountClock(connection).read(userId, accountId) }
      finally { connection.release() }
    },
  })
  const instrumentCollector = new BridgeInstrumentCollector(queries, createMysqlInstrumentSnapshotReader(pool), createInstrumentProjectionWriter(pool))
  const instruments = new BridgeInstrumentWorker(createMysqlInstrumentCollectionTasks(pool), leases, instrumentCollector)
  const { commands } = await createPositionProtectionCommandRuntime({ pool, routes: leases,
    limits: { maxAgeMs: config.positionProtectionMaxAgeMs, maxInstrumentAgeMs: config.positionProtectionMaxInstrumentAgeMs } })
  const gateway = new BridgeGatewayService(
    createBridgeSessionTickets(cache),
    routes,
    leases,
    capacity,
    directory,
    transport,
    commands,
    streams, undefined, queries,
  )

  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 })
  const webSockets = new BridgeV4WebSocketServer(app.server, gateway,
    (code, storageCode) => app.log.warn({ code, storageCode }, 'bridge session rejected'))
  app.get('/health/live', async () => ({ status: 'ok', ...health.snapshot(), connections: webSockets.connectionCount(), history_queries: queries.inflight() }))
  app.get('/health/ready', async (_request, reply) => {
    const dependencies = await dependenciesReady(pool, cache) && commandWorker.isRunning() && historyWorker.isRunning() && instrumentWorker.isRunning()
    const snapshot = health.snapshot()
    const ready = dependencies && snapshot.accepting && snapshot.ready
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready', ...snapshot,
      dependencies_ready: dependencies, connections: webSockets.connectionCount(), history_queries: queries.inflight() })
  })

  const processCommand = createBridgeCommandProcessor(commands, transport)
  const commandWorker = new Worker<BridgeCommandJob>(BRIDGE_DISPATCH_QUEUE, async job => {
    const result = await processCommand(job)
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  commandWorker.on('failed', (_job, error) => health.workFailed(publicError(error)))

  const processHistoryTask = createBridgeHistoryTaskProcessor(historyTasks)
  const historyWorker = new Worker<BridgeHistoryTaskJob>(BRIDGE_HISTORY_TASK_QUEUE, async (job, token) => {
    const result = await processHistoryTask(job, token)
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  historyWorker.on('failed', (_job, error) => health.workFailed(publicError(error)))

  const processInstrument = createBridgeInstrumentProcessor(instruments)
  const instrumentWorker = new Worker<BridgeInstrumentJob>(BRIDGE_INSTRUMENT_QUEUE, async (job, token) => {
    const result = await processInstrument(job, token)
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  instrumentWorker.on('failed', (_job, error) => health.workFailed(publicError(error)))

  await marketDemands.start()
  await marketReads.start()
  webSockets.start()
  await app.listen({ host: config.host, port: config.bridgeGatewayPort })
  void commandWorker.run()
  void historyWorker.run()
  void instrumentWorker.run()
  health.setReady(true)
  health.setAccepting(true)

  installProcessLifecycle('bridge-gateway', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await commandWorker.close()
    await historyWorker.close()
    await instrumentWorker.close()
    await marketReads.close()
    await marketDemands.close()
    await webSockets.close()
    await app.close()
    await Promise.allSettled([marketCache.quit(), cache.quit(), pool.end()])
  })
}

async function dependenciesReady(pool: ReturnType<typeof createMysqlPool>, cache: ReturnType<typeof createCacheRedis>) {
  try { await Promise.all([pool.query('SELECT 1'), cache.ping()]); return true } catch { return false }
}
function safeError(error: unknown) { return error instanceof Error ? error.message : 'unknown_error' }
function publicError(error: unknown) { const value = safeError(error); return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'bridge_dispatch_failed' }

void main().catch(error => {
  console.error('[bridge-gateway] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
