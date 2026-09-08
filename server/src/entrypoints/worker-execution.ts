import { createTransactionAccountClock } from '../modules/trading/composition.js'
import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, connectCacheRedis, createCacheRedis, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import {
  BridgeCommandService, ExecutionDistributionTargetWorker, ExecutionPreparationWorker, ExecutionService,
  MysqlBridgeCommandRepository, MysqlExecutionCommandSource, MysqlExecutionDistributionRepository,
  MysqlExecutionRepository, MysqlUserExecutionCommandRepository, RedisAccountExecutionLeaseStore,
  UserExecutionCommandService,
} from '../modules/execution/index.js'
import { EXECUTION_QUEUE, type ExecutionJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-execution')
  const pool = createMysqlPool(config.mysql)
  const cache = createCacheRedis(config.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])
  const commands = new BridgeCommandService(new MysqlBridgeCommandRepository(pool, createTransactionAccountClock))
  const preparation = new ExecutionPreparationWorker(
    new MysqlExecutionCommandSource(pool, { magic: config.executionMagic, deviation: config.executionDeviation }),
    new RedisAccountExecutionLeaseStore(cache),
    commands,
  )
  const planning = new ExecutionService(new MysqlExecutionRepository(pool, createTransactionAccountClock))
  const distributionRepository = new MysqlExecutionDistributionRepository(pool)
  const distributionTargets = new ExecutionDistributionTargetWorker(
    distributionRepository,
    new UserExecutionCommandService(new MysqlUserExecutionCommandRepository(pool, createTransactionAccountClock)),
  )
  const worker = new Worker<ExecutionJob>(EXECUTION_QUEUE, async job => {
    if (job.name === 'execution.risk-decision.prepare') {
      if (!('riskDecisionId' in job.data) || !Number.isSafeInteger(job.data.userId) || job.data.userId < 1) throw new Error('risk_decision_job_invalid')
      const result = await planning.prepare(job.data.userId, job.data.riskDecisionId)
      health.workSucceeded()
      return { riskDecisionId: job.data.riskDecisionId, kind: result.kind }
    }
    if (job.name === 'execution.distribution.target') {
      if (!('distributionTargetId' in job.data) || !job.data.distributionTargetId) throw new Error('distribution_target_job_invalid')
      const result = await distributionTargets.run(job.data.distributionTargetId)
      health.workSucceeded()
      return result
    }
    if (!('intentId' in job.data)) throw new Error('execution_intent_job_invalid')
    if (!job.data.intentId) throw new Error('execution_intent_job_invalid')
    const result = await preparation.run(job.data.intentId)
    if (result.kind === 'busy') throw new Error('execution_prepare_busy')
    health.workSucceeded()
    if (result.kind === 'no_work') return { intentId: job.data.intentId, kind: result.kind }
    return { intentId: job.data.intentId, kind: result.kind, commandId: result.command.id }
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.executionConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error)))

  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.executionHealthPort,
    health,
    dependencyReady: async () => {
      try { await Promise.all([pool.query('SELECT 1'), cache.ping()]); return worker.isRunning() } catch { return false }
    },
  })
  void worker.run()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('worker-execution', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await worker.close()
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
