import { DelayedError, Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import {
  InferenceService, loadCredentialKeyring, MysqlInferenceRepository, MysqlInstrumentSnapshotReader,
  MysqlModelUsageLedger, MysqlRiskSummaryReader, MysqlRuntimeModelProfileCatalog, MysqlTraderModelGatewayResolver,
  TraderContextBuilder, TraderWorker,
} from '../modules/inference/index.js'
import { MysqlStrategyCatalog, StrategyService } from '../modules/strategies/index.js'
import { MysqlTradingRepository } from '../modules/trading/index.js'
import { TRADER_QUEUE, type TraderRunJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-trader')
  const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  const repository = new MysqlInferenceRepository(pool)
  const strategies = new StrategyService(new MysqlStrategyCatalog(pool))
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, loadCredentialKeyring(), {
    allowPrivateEndpoints: config.allowPrivateModelEndpoints,
    maxAttempts: config.modelMaxAttempts,
    defaultTimeoutMs: config.modelDefaultTimeoutMs,
  })
  const processor = new TraderWorker(
    repository,
    new InferenceService(repository, strategies),
    strategies,
    new TraderContextBuilder(repository, new MysqlTradingRepository(pool), new MysqlInstrumentSnapshotReader(pool), new MysqlRiskSummaryReader(pool)),
    new MysqlTraderModelGatewayResolver(profiles, new MysqlModelUsageLedger(pool)),
    `trader:${process.pid}`,
  )
  const worker = new Worker<TraderRunJob>(TRADER_QUEUE, async (job, token) => {
    if (job.name !== 'trader.run' || !job.data.traderRunId) throw new Error('trader_job_invalid')
    const result = await processor.process(job.data.traderRunId)
    if (result.status === 'deferred') {
      await job.moveToDelayed(Date.now() + Math.min(Math.max(result.retryAfterMs ?? 250, 250), 30_000), token)
      throw new DelayedError()
    }
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.traderConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error, 'trader_worker_failed')))
  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.traderHealthPort,
    health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return worker.isRunning() } catch { return false } },
  })
  void worker.run()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('worker-trader', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await worker.close()
    await closeHttpServer(healthServer)
    await pool.end()
  })
}

function publicError(error: unknown, fallback: string) {
  const value = error instanceof Error ? error.message : fallback
  return /^[a-z0-9_]{3,128}$/.test(value) ? value : fallback
}

void main().catch(error => {
  console.error('[worker-trader] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
