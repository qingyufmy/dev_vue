import {
  assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { assertMysqlExecutionWorkflowSchemaReady, createMysqlPartialCloseWorkflowRecovery } from '../modules/execution/composition.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('scheduler-execution')
  const pool = createMysqlPool(config.mysql)
  await assertMysqlExecutionWorkflowSchemaReady(pool)
  const recovery = createMysqlPartialCloseWorkflowRecovery(pool, { protecting: true })
  const loop = new AsyncPollLoop(async () => {
    try {
      await recovery.schedule(config.executionRecoveryBatchSize)
      health.workSucceeded()
    } catch (error) {
      health.workFailed(publicError(error))
      console.error('[scheduler-execution] tick failed', publicError(error))
    }
  }, config.executionRecoveryPollMs)
  const healthServer = await startRoleHealthServer({
    host: config.host, port: config.executionSchedulerHealthPort, health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return true } catch { return false } },
  })
  loop.start()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('scheduler-execution', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await loop.stop()
    await closeHttpServer(healthServer)
    await pool.end()
  })
}

function publicError(error: unknown) {
  const value = error instanceof Error ? error.message : 'execution_scheduler_failed'
  return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'execution_scheduler_failed'
}
void main().catch(error => { console.error('[scheduler-execution] startup failed', publicError(error)); process.exit(1) })
