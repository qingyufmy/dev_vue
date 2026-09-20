import { MarketGapConfirmations } from '../bootstrap/market-gap-confirmation-runtime.js'
import { createMarketHistoryDemand } from '../modules/market/composition.js'
import { createAccountPrincipalReader as createModelPrincipals, createActivePrincipalAccess as createModelActive } from '../modules/auth/composition.js'
import { createRuntimeStrategyAccess } from '../modules/strategies/composition.js'
import { createAccountRiskSummaryReader } from '../modules/risk/composition.js'
import { createAccountInventorySummaryReader } from '../modules/trading/composition.js'
import { createSubscriptionExecutionWindowReader, createAnalysisSubscriberReader, createAnalysisWindowReader } from '../modules/strategies/composition.js'
import { createBridgeGatewayLeases } from '../modules/bridge/composition.js'
import { createAccountPrincipalReader } from '../modules/auth/composition.js'
import { createMysqlAnalysisModelResolver, loadCredentialKeyring } from '../modules/inference/composition.js'
import { createMysqlInferenceRepository } from '../modules/inference/composition.js'
import { createTransactionAccountClock } from '../modules/trading/composition.js'
import { createAnalysisMarketSource, createAnalysisWindowGuard, createMysqlMacroSnapshotReader } from '../modules/inference/composition.js'
import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'

import {
  AnalysisContextBuilder, AnalysisWorker, InferenceService,
} from '../modules/inference/index.js'
import { createSubscriptionPreferencesReader, createMysqlStrategyService } from '../modules/strategies/composition.js'
import { createTradingReader } from '../modules/trading/composition.js'
import { createBridgeMarketSourceCandidates } from '../modules/trading/composition.js'
import { createMysqlMarketProviders } from '../modules/auth/composition.js'
import { MysqlMarketStrategyAccess } from '../modules/strategies/composition.js'
import { createMarketSourceSelector, assertMarketSourceSchemaReady } from '../modules/market/composition.js'
import { StrategyMarketSourceAccess } from '../modules/market/index.js'
import { ANALYSIS_QUEUE, type AnalysisRunJob } from '../queue/task-queues.js'
import { createMysqlRuntimeMemoryPreparationWriter, createMysqlRuntimeStrategyMemoryReader } from '../modules/reviews/composition.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-analysis')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])
  await assertMarketSourceSchemaReady(pool)
  const repository = createMysqlInferenceRepository(pool, createTransactionAccountClock, createSubscriptionPreferencesReader, createSubscriptionExecutionWindowReader, { subscribers: createAnalysisSubscriberReader, inventory: createAccountInventorySummaryReader, risks: createAccountRiskSummaryReader }, createMysqlRuntimeMemoryPreparationWriter)
  const strategies = createMysqlStrategyService(pool)
  const trading = createTradingReader(pool, createBridgeGatewayLeases(cache), createAccountPrincipalReader)
  const sources = createMarketSourceSelector(pool, createBridgeMarketSourceCandidates(trading, createMysqlMarketProviders(pool), createBridgeGatewayLeases(cache), cache))
  const sourceAccess = new StrategyMarketSourceAccess(new MysqlMarketStrategyAccess(pool), sources, createMarketHistoryDemand(cache))
  let usageSettlementFailureRevision = 0
  const processor = new AnalysisWorker(
    repository,
    new InferenceService(repository, strategies),
    strategies,
    new AnalysisContextBuilder(createAnalysisMarketSource(trading, sourceAccess, async () => {
      const providers = createMysqlMarketProviders(pool)
      const clock = await trading.getPublicDisplayClock(await providers.list())
      return clock && (await providers.list()).includes(clock.ownerUserId) ? clock : null
    }, (selection, timeframe, items, step) => new MarketGapConfirmations(cache).read(selection, timeframe, items, step)), createMysqlMacroSnapshotReader(pool), createMysqlRuntimeStrategyMemoryReader(pool)),
    createMysqlAnalysisModelResolver(pool, loadCredentialKeyring(), {
      allowPrivateEndpoints: config.allowPrivateModelEndpoints,
      maxAttempts: config.modelMaxAttempts,
      defaultTimeoutMs: config.modelDefaultTimeoutMs,
    }, { strategies: createRuntimeStrategyAccess, principals: createModelPrincipals, active: createModelActive }, () => {
      usageSettlementFailureRevision += 1
      health.workFailed('model_usage_settlement_failed')
      console.error('[worker-analysis] model usage settlement failed')
    }),
    `analysis:${process.pid}`,
    createAnalysisWindowGuard(createAnalysisWindowReader(pool), (accountId, userId) => trading.getAccountSnapshot(accountId, userId)),
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
