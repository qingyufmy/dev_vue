import { createTransactionAccountClock } from '../modules/trading/composition.js'
import { DelayedError, Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { RedisBridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import {
  InferenceService, loadCredentialKeyring, MysqlInferenceRepository, MysqlInstrumentSnapshotReader,
  MysqlModelUsageLedger, MysqlRiskSummaryReader, MysqlRuntimeModelProfileCatalog, MysqlTraderModelGatewayResolver,
  TraderContextBuilder, TraderWorker, MysqlTraderWindowGuard, MysqlTraderPreferencesReader,
} from '../modules/inference/index.js'
import { createSubscriptionPreferencesReader, createMysqlStrategyService } from '../modules/strategies/composition.js'
import { createTradingReader } from '../modules/trading/composition.js'
import { TRADER_QUEUE, type TraderRunJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-trader')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])
  const repository = new MysqlInferenceRepository(pool, createTransactionAccountClock, createSubscriptionPreferencesReader)
  const strategies = createMysqlStrategyService(pool)
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, loadCredentialKeyring(), {
    allowPrivateEndpoints: config.allowPrivateModelEndpoints,
    maxAttempts: config.modelMaxAttempts,
    defaultTimeoutMs: config.modelDefaultTimeoutMs,
  })
  let usageSettlementFailureRevision = 0
  const processor = new TraderWorker(
    repository,
    new InferenceService(repository, strategies),
    strategies,
    new TraderContextBuilder(repository, createTradingReader(pool, new RedisBridgeGatewayLeaseStore(cache)), new MysqlInstrumentSnapshotReader(pool), new MysqlRiskSummaryReader(pool), new MysqlTraderPreferencesReader(pool, createSubscriptionPreferencesReader)),
    new MysqlTraderModelGatewayResolver(profiles, new MysqlModelUsageLedger(pool), () => {
      usageSettlementFailureRevision += 1
      health.workFailed('model_usage_settlement_failed')
      console.error('[worker-trader] model usage settlement failed')
    }),
    `trader:${process.pid}`,
    new MysqlTraderWindowGuard(pool, createTransactionAccountClock),
  )
  const worker = new Worker<TraderRunJob>(TRADER_QUEUE, async (job, token) => {
    if (job.name !== 'trader.run' || !job.data.traderRunId) throw new Error('trader_job_invalid')
    const settlementRevision = usageSettlementFailureRevision
    const result = await processor.process(job.data.traderRunId)
    if (result.status === 'deferred') {
      await job.moveToDelayed(Date.now() + Math.min(Math.max(result.retryAfterMs ?? 250, 250), 30_000), token)
      throw new DelayedError()
    }
    if (settlementRevision === usageSettlementFailureRevision) health.workSucceeded()
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
    await Promise.allSettled([cache.quit(), pool.end()])
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
