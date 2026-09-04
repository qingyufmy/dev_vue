import {
  assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import {
  AnalysisScheduler, InferenceService, ModelTaskRecovery, MysqlAnalysisScheduleRepository,
  MysqlInferenceRepository, MysqlModelTaskRecoveryRepository,
} from '../modules/inference/index.js'
import { MysqlStrategyCatalog, StrategyService } from '../modules/strategies/index.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('scheduler-analysis')
  const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  const strategies = new StrategyService(new MysqlStrategyCatalog(pool))
  const scheduler = new AnalysisScheduler(
    new MysqlAnalysisScheduleRepository(pool),
    new InferenceService(new MysqlInferenceRepository(pool), strategies),
  )
  const recovery = new ModelTaskRecovery(new MysqlModelTaskRecoveryRepository(pool))
  const loop = new AsyncPollLoop(async () => {
    try {
      await recovery.expireOverdue(new Date(), config.modelRecoveryBatchSize)
      const result = await scheduler.tick(new Date(), config.analysisScheduleBatchSize)
      if (result.failures.length > 0) {
        health.workFailed('analysis_schedule_partial_failure')
        console.error('[scheduler-analysis] schedules failed', result.failures.length)
      } else health.workSucceeded()
    } catch (error) {
      health.workFailed(publicError(error, 'analysis_scheduler_failed'))
      console.error('[scheduler-analysis] tick failed', error instanceof Error ? error.message : 'unknown_error')
    }
  }, config.analysisSchedulePollMs)
  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.analysisSchedulerHealthPort,
    health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return true } catch { return false } },
  })
  loop.start()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('scheduler-analysis', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await loop.stop()
    await closeHttpServer(healthServer)
    await pool.end()
  })
}

function publicError(error: unknown, fallback: string) {
  const value = error instanceof Error ? error.message : fallback
  return /^[a-z0-9_]{3,128}$/.test(value) ? value : fallback
}

void main().catch(error => {
  console.error('[scheduler-analysis] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
