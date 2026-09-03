import Fastify from 'fastify'
import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import {
  BridgeCommandService, MysqlBridgeCommandRepository,
} from '../modules/execution/index.js'
import {
  BridgeGatewayCommandTransport, BridgeGatewayService, BridgeTradeProjectionDecoder, BridgeV4StreamIngestor,
  InProcessBridgeGatewayDirectory, MysqlBridgeGatewayRouteRepository, RedisBridgeGatewayLeaseStore,
  RedisBridgeSessionTicketStore,
} from '../modules/bridge/index.js'
import {
  BridgeStreamProjector, MysqlTradingRepository, RedisBrowserRealtimePublisher,
} from '../modules/trading/index.js'
import { BRIDGE_DISPATCH_QUEUE, type BridgeCommandJob } from '../queue/task-queues.js'
import { BridgeV4WebSocketServer } from '../transport/bridge-v4-websocket-server.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('bridge-gateway')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])

  const trading = new MysqlTradingRepository(pool)
  const publisher = new RedisBrowserRealtimePublisher(cache, 'aurum:v4:browser-realtime:events', error => {
    console.error('[bridge-gateway] realtime publish failed', safeError(error))
  })
  const projector = new BridgeStreamProjector(trading, publisher)
  const streams = new BridgeV4StreamIngestor(new BridgeTradeProjectionDecoder(), projector)
  const directory = new InProcessBridgeGatewayDirectory()
  const leases = new RedisBridgeGatewayLeaseStore(cache)
  const transport = new BridgeGatewayCommandTransport(leases, directory)
  const commands = new BridgeCommandService(new MysqlBridgeCommandRepository(pool))
  const gateway = new BridgeGatewayService(
    new RedisBridgeSessionTicketStore(cache),
    new MysqlBridgeGatewayRouteRepository(pool),
    leases,
    trading,
    directory,
    transport,
    commands,
    streams,
  )

  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 })
  const webSockets = new BridgeV4WebSocketServer(app.server, gateway)
  app.get('/health/live', async () => ({ status: 'ok', ...health.snapshot(), connections: webSockets.connectionCount() }))
  app.get('/health/ready', async (_request, reply) => {
    const dependencies = await dependenciesReady(pool, cache) && commandWorker.isRunning()
    const snapshot = health.snapshot()
    const ready = dependencies && snapshot.accepting && snapshot.ready
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready', ...snapshot,
      dependencies_ready: dependencies, connections: webSockets.connectionCount() })
  })

  const commandWorker = new Worker<BridgeCommandJob>(BRIDGE_DISPATCH_QUEUE, async job => {
    if (!job.data.commandId) throw new Error('bridge_command_job_invalid')
    const result = await commands.dispatchQueued(job.data.commandId, transport)
    health.workSucceeded()
    return { commandId: result.command.id, status: result.command.status, dispatched: result.dispatched }
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  commandWorker.on('failed', (_job, error) => health.workFailed(publicError(error)))

  webSockets.start()
  await app.listen({ host: config.host, port: config.bridgeGatewayPort })
  void commandWorker.run()
  health.setReady(true)
  health.setAccepting(true)

  installProcessLifecycle('bridge-gateway', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await commandWorker.close()
    await webSockets.close()
    await app.close()
    await Promise.allSettled([cache.quit(), pool.end()])
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
