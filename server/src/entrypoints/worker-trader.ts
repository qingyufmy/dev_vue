import { TraderAdmission } from '../queue/trader-admission.js'
import { createAccountPositionEntryReader } from '../bootstrap/account-position-entry-evidence.js'
import { assertMysqlHistoryTaskSchemaReady } from '../modules/trade-history/composition.js'
import { assertMysqlExecutionWorkflowSchemaReady } from '../modules/execution/composition.js'
import { createAccountPrincipalReader as createModelPrincipals, createActivePrincipalAccess as createModelActive } from '../modules/auth/composition.js'
import { createRuntimeStrategyAccess } from '../modules/strategies/composition.js'
import { createAccountRiskSummaryReader } from '../modules/risk/composition.js'
import { createAccountInventorySummaryReader } from '../modules/trading/composition.js'
import { createSubscriptionExecutionWindowReader, createAnalysisSubscriberReader } from '../modules/strategies/composition.js'
import { assertMysqlInstrumentCollectionSchemaReady } from '../modules/trading/composition.js'
import { createBridgeGatewayLeases } from '../modules/bridge/composition.js'
import { createAccountPrincipalReader } from '../modules/auth/composition.js'
import { createMysqlTraderModelResolver, loadCredentialKeyring } from '../modules/inference/composition.js'
import { createMysqlInferenceRepository } from '../modules/inference/composition.js'
import { createTransactionAccountClock } from '../modules/trading/composition.js'
import { createMysqlTraderContext, createMysqlTraderWindowGuard } from '../modules/inference/composition.js'
import { DelayedError, Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'

import {
  InferenceService,
  TraderWorker,
} from '../modules/inference/index.js'
import { createSubscriptionPreferencesReader, createMysqlStrategyService } from '../modules/strategies/composition.js'
import { createTradingReader, createMysqlInstrumentSnapshotReader, createMysqlInstrumentCollectionRequester } from '../modules/trading/composition.js'
import { TRADER_QUEUE, type TraderRunJob } from '../queue/task-queues.js'
import { createMysqlRuntimeMemoryPreparationWriter, createMysqlRuntimeStrategyMemoryReader } from '../modules/reviews/composition.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-trader')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])
  await assertMysqlInstrumentCollectionSchemaReady(pool)
  await assertMysqlHistoryTaskSchemaReady(pool)
  await assertMysqlExecutionWorkflowSchemaReady(pool)
  const routes = createBridgeGatewayLeases(cache)
  const repository = createMysqlInferenceRepository(pool, createTransactionAccountClock, createSubscriptionPreferencesReader, createSubscriptionExecutionWindowReader, { subscribers: createAnalysisSubscriberReader, inventory: createAccountInventorySummaryReader, risks: createAccountRiskSummaryReader }, createMysqlRuntimeMemoryPreparationWriter)
  const strategies = createMysqlStrategyService(pool)
  let usageSettlementFailureRevision = 0
  const processor = new TraderWorker(
    repository,
    new InferenceService(repository, strategies),
    strategies,
    createMysqlTraderContext(pool, repository, createTradingReader(pool, routes, createAccountPrincipalReader), createSubscriptionPreferencesReader, createMysqlInstrumentSnapshotReader(pool), createMysqlInstrumentCollectionRequester(pool), createAccountRiskSummaryReader(pool), createMysqlRuntimeStrategyMemoryReader(pool), createAccountPositionEntryReader(pool,routes)),
    createMysqlTraderModelResolver(pool, loadCredentialKeyring(), {
      allowPrivateEndpoints: config.allowPrivateModelEndpoints,
      maxAttempts: config.modelMaxAttempts,
      defaultTimeoutMs: config.modelDefaultTimeoutMs,
    }, { strategies: createRuntimeStrategyAccess, principals: createModelPrincipals, active: createModelActive }, () => {
      usageSettlementFailureRevision += 1
      health.workFailed('model_usage_settlement_failed')
      console.error('[worker-trader] model usage settlement failed')
    }),
    `trader:${process.pid}`,
    createMysqlTraderWindowGuard(pool, createTransactionAccountClock, createSubscriptionExecutionWindowReader),
  )
  const admission = new TraderAdmission(cache, config.queuePrefix, config.traderUserConcurrency)
  const worker = new Worker<TraderRunJob>(TRADER_QUEUE, async (job, token) => {
    if (job.name !== 'trader.run' || !job.data.traderRunId) throw new Error('trader_job_invalid')
    const settlementRevision = usageSettlementFailureRevision
    const run = await repository.getTraderRun(job.data.traderRunId)
    if (!run || run.status !== 'queued') return { status: 'ignored' }
    const permit = await admission.enter(run.userId, run.tradingAccountId)
    if (!permit) {
      await job.moveToDelayed(Date.now() + 1000, token)
      throw new DelayedError()
    }
    const started = Date.now()
    let result
    try { result = await processor.process(job.data.traderRunId) }
    finally {
      await permit.close()
      if (permit.lost) health.workFailed('trader_admission_lease_lost')
    }
    console.info(JSON.stringify({ event: 'trader_evaluation_timing', run_id: run.id,
      queue_wait_ms: Math.max(0, started - job.timestamp), processing_ms: Date.now() - started,
      outcome: result.status }))
    if (result.status === 'deferred') {
      await job.moveToDelayed(Date.now() + Math.min(Math.max(result.retryAfterMs ?? 250, 250), 30_000), token)
      throw new DelayedError()
    }
    if (!permit.lost && settlementRevision === usageSettlementFailureRevision) health.workSucceeded()
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
