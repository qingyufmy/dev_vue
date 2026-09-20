import { createPeriodReviewTaskRunner } from '../bootstrap/period-review-workflow.js'
import { createPeriodReviewRecovery } from '../bootstrap/period-review-recovery.js'
import { createPeriodReviewProcessor, type PeriodReviewJob } from '../queue/period-review-processor.js'
import { createAccountPrincipalReader as createModelPrincipals, createActivePrincipalAccess as createModelActive } from '../modules/auth/composition.js'
import { createRuntimeStrategyAccess } from '../modules/strategies/composition.js'
import { createMysqlReviewModelResolver, loadCredentialKeyring } from '../modules/inference/composition.js'
import { Queue, Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { createMysqlReviewRecovery, createMysqlReviewWorker } from '../modules/reviews/composition.js'
import { createManualCandidateTaskRunner } from '../bootstrap/manual-candidate-batch.js'
import { createManualCandidateRecovery } from '../bootstrap/manual-candidate-recovery.js'
import { createSystemReviewTaskRunner } from '../bootstrap/system-review-batch.js'
import { createSystemReviewRecovery } from '../bootstrap/system-review-recovery.js'
import { createSystemReviewProcessor, type SystemReviewJob } from '../queue/system-review-processor.js'
import { assertMysqlSystemReviewTaskSchemaReady } from '../modules/reviews/composition.js'
import { createManualCandidateProcessor, type ManualCandidateJob } from '../queue/manual-candidate-processor.js'
import { assertMysqlExecutionWorkflowSchemaReady } from '../modules/execution/composition.js'
import { MANUAL_CANDIDATE_QUEUE, SYSTEM_REVIEW_QUEUE, PERIOD_REVIEW_QUEUE, REVIEW_QUEUE, type ReviewRunJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig(); assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-review'); const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  await assertMysqlExecutionWorkflowSchemaReady(pool)
  await assertMysqlSystemReviewTaskSchemaReady(pool)
  const models = createMysqlReviewModelResolver(pool, loadCredentialKeyring(), {
    allowPrivateEndpoints: config.allowPrivateModelEndpoints, maxAttempts: config.modelMaxAttempts, defaultTimeoutMs: config.modelDefaultTimeoutMs,
  }, { strategies: createRuntimeStrategyAccess, principals: createModelPrincipals, active: createModelActive }, () => health.workFailed('review_model_usage_settlement_failed'))
  const processor = createMysqlReviewWorker(pool, models, `review:${process.pid}`)
  const worker = new Worker<ReviewRunJob>(REVIEW_QUEUE, async job => {
    if (job.name !== 'review.run' || !job.data.reviewJobId) throw new Error('review_job_invalid')
    const result = await processor.process(job.data.reviewJobId)
    result.status === 'succeeded' || result.status === 'ignored' ? health.workSucceeded() : health.workFailed(result.code)
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.reviewConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error)))
  const candidateQueue = new Queue(MANUAL_CANDIDATE_QUEUE, { connection: config.queueRedis, prefix: config.queuePrefix })
  const candidates = new Worker<ManualCandidateJob>(MANUAL_CANDIDATE_QUEUE, createManualCandidateProcessor(createManualCandidateTaskRunner(pool)),
    { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  candidates.on('failed', (_job, error) => health.workFailed(publicError(error)))
  const candidateRecovery = createManualCandidateRecovery(pool, candidateQueue)
  const systemQueue = new Queue(SYSTEM_REVIEW_QUEUE, { connection: config.queueRedis, prefix: config.queuePrefix })
  const systemReviews = new Worker<SystemReviewJob>(SYSTEM_REVIEW_QUEUE, createSystemReviewProcessor(createSystemReviewTaskRunner(pool)),
    { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  systemReviews.on('failed', (_job, error) => health.workFailed(publicError(error)))
  const systemRecovery = createSystemReviewRecovery(pool, systemQueue)
  const periodQueue = new Queue(PERIOD_REVIEW_QUEUE, { connection: config.queueRedis, prefix: config.queuePrefix })
  const periodReviews = new Worker<PeriodReviewJob>(PERIOD_REVIEW_QUEUE, createPeriodReviewProcessor(createPeriodReviewTaskRunner(pool)),
    { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: 1, autorun: false })
  periodReviews.on('failed', (_job, error) => health.workFailed(publicError(error)))
  const periodRecovery = createPeriodReviewRecovery(pool, periodQueue)
  const healthServer = await startRoleHealthServer({
    host: config.host, port: config.reviewHealthPort, health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return worker.isRunning() && candidates.isRunning() && systemReviews.isRunning() && periodReviews.isRunning() } catch { return false } },
  })
  const recoveryQueue = new Queue(REVIEW_QUEUE, { connection: config.queueRedis, prefix: config.queuePrefix })
  const recovery = createMysqlReviewRecovery(pool, recoveryQueue)
  const sweep = () => {
    void recovery.tick().catch(() => health.workFailed('review_recovery_failed'))
    void candidateRecovery.tick().catch(() => health.workFailed('manual_candidate_recovery_failed'))
    void systemRecovery.tick().catch(() => health.workFailed('system_review_recovery_failed'))
    void periodRecovery.tick().catch(() => health.workFailed('period_review_recovery_failed'))
  }
  const recoveryTimer = setInterval(sweep, 15_000)
  recoveryTimer.unref()
  sweep()
  void periodReviews.run(); void candidates.run(); void systemReviews.run(); void worker.run(); health.setReady(true); health.setAccepting(true)
  installProcessLifecycle('worker-review', async () => {
    health.setAccepting(false); health.setReady(false)
    clearInterval(recoveryTimer)
    await recovery.stop().catch(() => health.workFailed('review_recovery_failed'))
    await candidateRecovery.stop().catch(() => health.workFailed('manual_candidate_recovery_failed'))
    await systemRecovery.stop().catch(() => health.workFailed('system_review_recovery_failed'))
    await periodRecovery.stop().catch(() => health.workFailed('period_review_recovery_failed'))
    await periodReviews.close(); await periodQueue.close()
    await systemReviews.close(); await systemQueue.close()
    await candidates.close(); await candidateQueue.close()
    await recoveryQueue.close()
    await worker.close(); await closeHttpServer(healthServer); await pool.end()
  })
}

function publicError(error: unknown) { const value = error instanceof Error ? error.message : 'review_worker_failed'; return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'review_worker_failed' }
void main().catch(error => { console.error('[worker-review] startup failed', error instanceof Error ? error.stack : String(error)); process.exit(1) })
