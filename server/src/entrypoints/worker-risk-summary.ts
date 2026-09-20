import { createAccountRiskProjection } from '../bootstrap/account-risk-projection.js'
import { assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer } from '../bootstrap/index.js'

loadServerEnvironment()
async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const pool = createMysqlPool(config.mysql), health = new RoleHealth('worker-risk-summary')
  await pool.query('SELECT trading_account_id FROM account_daily_risk_baselines LIMIT 0')
  const projector = createAccountRiskProjection(pool)
  let previous = ''
  const loop = new AsyncPollLoop(async () => {
    try {
      const results = await projector.tick()
      const status = JSON.stringify(results.map(({ revision: _, ...result }) => result))
      if (status !== previous) { console.log('[worker-risk-summary]', status); previous = status }
      if (results.some(result => result.status === 'unavailable')) health.workFailed('risk_summary_source_unavailable')
      else health.workSucceeded()
    } catch { health.workFailed('risk_summary_projection_failed') }
  }, 10000)
  const server = await startRoleHealthServer({ host: config.host, port: config.riskSummaryHealthPort, health,
    dependencyReady: async () => { try { await pool.query('SELECT 1'); return true } catch { return false } } })
  loop.start(); health.setReady(true); health.setAccepting(true)
  installProcessLifecycle('worker-risk-summary', async () => {
    health.setAccepting(false); health.setReady(false)
    await loop.stop(); await closeHttpServer(server); await pool.end()
  })
}
void main().catch(error => { console.error('[worker-risk-summary] startup failed', error instanceof Error ? error.message : 'unknown'); process.exit(1) })
