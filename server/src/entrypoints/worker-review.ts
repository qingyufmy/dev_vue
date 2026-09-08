import { createMysqlReviewModelResolver, loadCredentialKeyring } from '../modules/inference/composition.js'
import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { createMysqlReviewWorker } from '../modules/reviews/composition.js'
import { REVIEW_QUEUE, type ReviewRunJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig(); assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-review'); const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  const models = createMysqlReviewModelResolver(pool, loadCredentialKeyring(), {
    allowPrivateEndpoints: config.allowPrivateModelEndpoints, maxAttempts: config.modelMaxAttempts, defaultTimeoutMs: config.modelDefaultTimeoutMs,
  }, () => health.workFailed('review_model_usage_settlement_failed'))
  const processor = createMysqlReviewWorker(pool, models, `review:${process.pid}`)
  const worker = new Worker<ReviewRunJob>(REVIEW_QUEUE, async job => {
    if (job.name !== 'review.run' || !job.data.reviewJobId) throw new Error('review_job_invalid')
    const result = await processor.process(job.data.reviewJobId)
    result.status === 'succeeded' || result.status === 'ignored' ? health.workSucceeded() : health.workFailed(result.code)
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.reviewConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error)))
  const healthServer = await startRoleHealthServer({
    host: config.host, port: config.reviewHealthPort, health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return worker.isRunning() } catch { return false } },
  })
  void worker.run(); health.setReady(true); health.setAccepting(true)
  installProcessLifecycle('worker-review', async () => {
    health.setAccepting(false); health.setReady(false)
    await worker.close(); await closeHttpServer(healthServer); await pool.end()
  })
}

function publicError(error: unknown) { const value = error instanceof Error ? error.message : 'review_worker_failed'; return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'review_worker_failed' }
void main().catch(error => { console.error('[worker-review] startup failed', error instanceof Error ? error.stack : String(error)); process.exit(1) })
