import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { RedisBridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import {
  AnalysisContextBuilder, AnalysisWorker, InferenceService, loadCredentialKeyring,
  MysqlAnalysisModelGatewayResolver, MysqlInferenceRepository, MysqlMacroSnapshotReader, MysqlModelUsageLedger,
  MysqlRuntimeModelProfileCatalog, TradingAnalysisMarketSource,
  MysqlAnalysisWindowGuard,
} from '../modules/inference/index.js'
import { MysqlStrategyCatalog, StrategyService } from '../modules/strategies/index.js'
import { createTradingReader } from '../modules/trading/composition.js'
import { ANALYSIS_QUEUE, type AnalysisRunJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-analysis')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])
  const repository = new MysqlInferenceRepository(pool)
  const strategies = new StrategyService(new MysqlStrategyCatalog(pool))
  const trading = createTradingReader(pool, new RedisBridgeGatewayLeaseStore(cache))
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, loadCredentialKeyring(), {
    allowPrivateEndpoints: config.allowPrivateModelEndpoints,
    maxAttempts: config.modelMaxAttempts,
    defaultTimeoutMs: config.modelDefaultTimeoutMs,
  })
  let usageSettlementFailureRevision = 0
  const processor = new AnalysisWorker(
    repository,
    new InferenceService(repository, strategies),
    strategies,
    new AnalysisContextBuilder(new TradingAnalysisMarketSource(trading), new MysqlMacroSnapshotReader(pool)),
    new MysqlAnalysisModelGatewayResolver(profiles, new MysqlModelUsageLedger(pool), () => {
      usageSettlementFailureRevision += 1
      health.workFailed('model_usage_settlement_failed')
      console.error('[worker-analysis] model usage settlement failed')
    }),
    `analysis:${process.pid}`,
    new MysqlAnalysisWindowGuard(pool, (accountId, userId) => trading.getAccountSnapshot(accountId, userId)),
  )
  const worker = new Worker<AnalysisRunJob>(ANALYSIS_QUEUE, async job => {
    if (job.name !== 'analysis.run' || !job.data.analysisId) throw new Error('analysis_job_invalid')
    const settlementRevision = usageSettlementFailureRevision
    const result = await processor.process(job.data.analysisId)
    if (settlementRevision === usageSettlementFailureRevision) health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.analysisConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error, 'analysis_worker_failed')))
  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.analysisHealthPort,
    health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return worker.isRunning() } catch { return false } },
  })
  void worker.run()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('worker-analysis', async () => {
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
  console.error('[worker-analysis] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
