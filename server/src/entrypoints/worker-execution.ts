import { createTradeDecisionReapprovalWriter } from '../modules/inference/composition.js'
import { createExecutionProcessor } from '../queue/execution-processor.js'
import { createPendingPreparationRuntime } from '../bootstrap/pending-preparation-runtime.js'
import { createTransactionRiskDecisionExecutionWriter } from '../modules/risk/composition.js'
import { createStrategyExecutionConfigReader } from '../modules/strategies/composition.js'
import { createTransactionAccountClock } from '../modules/trading/composition.js'
import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import {
  ExecutionDistributionTargetWorker, ExecutionPreparationWorker, ExecutionService,
  UserExecutionCommandService,
} from '../modules/execution/index.js'
import { MysqlExecutionCommandSource, MysqlExecutionDistributionRepository,
  MysqlExecutionRepository, MysqlUserExecutionCommandRepository, RedisAccountExecutionLeaseStore,
} from '../modules/execution/composition.js'
import { EXECUTION_QUEUE, type ExecutionJob } from '../queue/task-queues.js'
import { PARTIAL_CLOSE_WORKFLOW_QUEUE, type PartialCloseWorkflowJob } from '../queue/partial-close-workflow-queue.js'
import { createBridgeGatewayLeases } from '../modules/bridge/composition.js'
import { createPositionProtectionPreparationRuntime } from '../bootstrap/position-protection-preparation-runtime.js'
import { createPartialCloseWorkflowRuntime } from '../bootstrap/partial-close-workflow-runtime.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-execution')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])
  const routes = createBridgeGatewayLeases(cache)
  const limits = { maxAgeMs: config.positionProtectionMaxAgeMs, maxInstrumentAgeMs: config.positionProtectionMaxInstrumentAgeMs }
  const receivers = await createPositionProtectionPreparationRuntime({ pool, cache, routes, limits,
    magic: config.executionMagic, deviation: config.executionDeviation })
  const { commands } = receivers
  const workflows = await createPartialCloseWorkflowRuntime({ pool, routes, limits, prepared: receivers.prepared, reconcile: receivers.reconcile })
  const preparation = new ExecutionPreparationWorker(
    new MysqlExecutionCommandSource(pool, { magic: config.executionMagic, deviation: config.executionDeviation }),
    new RedisAccountExecutionLeaseStore(cache),
    commands,
  )
  const planning = new ExecutionService(new MysqlExecutionRepository(pool, createTransactionAccountClock, createTransactionRiskDecisionExecutionWriter, createStrategyExecutionConfigReader, createPendingPreparationRuntime(routes), createTradeDecisionReapprovalWriter))
  const distributionRepository = new MysqlExecutionDistributionRepository(pool)
  const distributionTargets = new ExecutionDistributionTargetWorker(
    distributionRepository,
    new UserExecutionCommandService(new MysqlUserExecutionCommandRepository(pool, createTransactionAccountClock)),
  )
  const processExecution = createExecutionProcessor({ planning, preparation, distributionTargets })
  const worker = new Worker<ExecutionJob>(EXECUTION_QUEUE, async (job, token) => {
    const result = await processExecution(job, token)
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.executionConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error)))
  const workflowWorker = new Worker<PartialCloseWorkflowJob>(PARTIAL_CLOSE_WORKFLOW_QUEUE, async (job, token) => {
    const result = await workflows.processor(job, token)
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.executionConcurrency, autorun: false })
  workflowWorker.on('failed', (_job, error) => health.workFailed(publicError(error)))
  await Promise.all([worker.waitUntilReady(), workflowWorker.waitUntilReady()])

  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.executionHealthPort,
    health,
    dependencyReady: async () => {
      try { await Promise.all([pool.query('SELECT 1'), cache.ping()]); return worker.isRunning() && workflowWorker.isRunning() } catch { return false }
    },
  })
  void worker.run()
  void workflowWorker.run()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('worker-execution', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await Promise.all([worker.close(), workflowWorker.close()])
    await closeHttpServer(healthServer)
    await Promise.allSettled([cache.quit(), pool.end()])
  })
}

function publicError(error: unknown) {
  const value = error instanceof Error ? error.message : 'execution_worker_failed'
  return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'execution_worker_failed'
}

void main().catch(error => {
  console.error('[worker-execution] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
