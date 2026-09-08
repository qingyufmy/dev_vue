import { Worker } from 'bullmq'
import {
  assertV4RuntimeEnabled, closeHttpServer, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { createRiskReviewWorker } from '../modules/risk/composition.js'
import { RISK_QUEUE, type RiskReviewJob } from '../queue/task-queues.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('worker-risk')
  const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  const processor = createRiskReviewWorker(pool)
  const worker = new Worker<RiskReviewJob>(RISK_QUEUE, async job => {
    if (job.name !== 'risk.review' || !job.data.decisionId) throw new Error('risk_job_invalid')
    const result = await processor.process(job.data.decisionId)
    health.workSucceeded()
    return result
  }, { connection: config.queueRedis, prefix: config.queuePrefix, concurrency: config.riskConcurrency, autorun: false })
  worker.on('failed', (_job, error) => health.workFailed(publicError(error, 'risk_worker_failed')))
  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.riskHealthPort,
    health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return worker.isRunning() } catch { return false } },
  })
  void worker.run()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('worker-risk', async () => {
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
  console.error('[worker-risk] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
