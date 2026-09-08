import {
  assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import { createMysqlTradeHistoryScheduler } from '../modules/trade-history/composition.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('scheduler-trade-history')
  const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  const scheduler = createMysqlTradeHistoryScheduler(pool)
  const loop = new AsyncPollLoop(async () => {
    try {
      await scheduler.schedule(config.historyScheduleBatchSize, new Date())
      health.workSucceeded()
    } catch (error) {
      health.workFailed(publicError(error))
      console.error('[scheduler-trade-history] tick failed', error instanceof Error ? error.message : 'unknown_error')
    }
  }, config.historySchedulePollMs)
  const healthServer = await startRoleHealthServer({
    host: config.host,
    port: config.historySchedulerHealthPort,
    health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return true } catch { return false } },
  })
  loop.start()
  health.setReady(true)
  health.setAccepting(true)
  installProcessLifecycle('scheduler-trade-history', async () => {
    health.setAccepting(false); health.setReady(false)
    await loop.stop(); await closeHttpServer(healthServer); await pool.end()
  })
}

function publicError(error: unknown) { const value = error instanceof Error ? error.message : 'trade_history_scheduler_failed'; return /^[a-z0-9_]{3,128}$/.test(value) ? value : 'trade_history_scheduler_failed' }
void main().catch(error => { console.error('[scheduler-trade-history] startup failed', error instanceof Error ? error.stack : String(error)); process.exit(1) })
