import {
  assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import {
  BullMqOutboxTaskPublisher, CompositeOutboxPublisher, MysqlOutboxRepository,
  OutboxDispatcher, RedisOutboxRealtimePublisher,
} from '../outbox/index.js'
import { RuntimeTaskQueues } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('outbox-dispatcher')
  const pool = createMysqlPool(config.mysql)
  const realtimeRedis = createCacheRedis(config.cacheRedis)
  await pool.query('SELECT 1')
  await connectCacheRedis(realtimeRedis)
  const queues = new RuntimeTaskQueues(config.queueRedis, config.queuePrefix)
  await Promise.all([
    queues.execution.waitUntilReady(), queues.bridgeDispatch.waitUntilReady(), queues.analysis.waitUntilReady(),
    queues.trader.waitUntilReady(), queues.risk.waitUntilReady(),
  ])
  const dispatcher = new OutboxDispatcher(new MysqlOutboxRepository(pool), new CompositeOutboxPublisher([
    new BullMqOutboxTaskPublisher(queues),
    new RedisOutboxRealtimePublisher(pool, realtimeRedis),
  ]))
  const loop = new AsyncPollLoop(async () => {
    try {
      await dispatcher.runBatch(50)
      health.workSucceeded()
    } catch (error) {
      health.workFailed(publicError(error))
      console.error('[outbox-dispatcher] batch failed', error instanceof Error ? error.message : 'unknown_error')
    }
  }, 250)
  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.outboxHealthPort,
    health,
    dependencyReady: async () => {
      try {
        await Promise.all([
          pool.query('SELECT 1'), realtimeRedis.ping(), queues.execution.getJobCounts(), queues.bridgeDispatch.getJobCounts(),
          queues.analysis.getJobCounts(), queues.trader.getJobCounts(), queues.risk.getJobCounts(),
        ])
        return true
      } catch { return false }
    },
  })
  loop.start()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('outbox-dispatcher', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await loop.stop()
    await closeHttpServer(healthServer)
    await Promise.allSettled([queues.close(), realtimeRedis.quit(), pool.end()])
  })
}

function publicError(error: unknown) {
  const value = error instanceof Error ? error.message : 'outbox_dispatch_failed'
  return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'outbox_dispatch_failed'
}

void main().catch(error => {
  console.error('[outbox-dispatcher] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
