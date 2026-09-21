import { createAccountPrincipalReader as createModelPrincipals, createActivePrincipalAccess as createModelActive } from '../modules/auth/composition.js'
import { createAccountRiskSummaryReader } from '../modules/risk/composition.js'
import { createAccountInventorySummaryReader } from '../modules/trading/composition.js'
import { createSubscriptionExecutionWindowReader, createAnalysisSubscriberReader } from '../modules/strategies/composition.js'
import { createAccountPrincipalReader } from '../modules/auth/composition.js'
import { createMysqlModelUsageLedger } from '../modules/inference/composition.js'
import { createMysqlInferenceRepository, createAnalysisScheduler, createIndependentTraderScheduler, createMysqlModelTaskRecovery } from '../modules/inference/composition.js'
import { createTransactionAccountClock } from '../modules/trading/composition.js'
import {
  assertV4RuntimeEnabled, AsyncPollLoop, closeHttpServer, createMysqlPool,
  installProcessLifecycle, loadServerEnvironment, loadV4RuntimeConfig, RoleHealth, startRoleHealthServer,
} from '../bootstrap/index.js'
import {
  InferenceService,

} from '../modules/inference/index.js'
import { createMysqlAnalysisScheduleStore, createSubscriptionPreferencesReader, createMysqlStrategyService } from '../modules/strategies/composition.js'
import { createTradingReader } from '../modules/trading/composition.js'
import { createAutomaticMarketSessionGate } from '../modules/market/composition.js'
import { MysqlMarketStrategyAccess } from '../modules/strategies/composition.js'

loadServerEnvironment()

async function main() {
  const config = loadV4RuntimeConfig()
  assertV4RuntimeEnabled(config)
  const health = new RoleHealth('scheduler-analysis')
  const pool = createMysqlPool(config.mysql)
  await pool.query('SELECT 1')
  const strategies = createMysqlStrategyService(pool)
  const trading = createTradingReader(pool, undefined, createAccountPrincipalReader)
  const inference = new InferenceService(createMysqlInferenceRepository(pool, createTransactionAccountClock, createSubscriptionPreferencesReader, createSubscriptionExecutionWindowReader, { subscribers: createAnalysisSubscriberReader, inventory: createAccountInventorySummaryReader, risks: createAccountRiskSummaryReader }), strategies)
  const marketSessions = createAutomaticMarketSessionGate(pool, new MysqlMarketStrategyAccess(pool))
  const scheduler = createAnalysisScheduler(
    createMysqlAnalysisScheduleStore(pool),
    inference,
    (accountId, userId) => trading.getAccountSnapshot(accountId, userId),
    marketSessions,
  )
  const independentTraderScheduler = createIndependentTraderScheduler(pool, inference, marketSessions)
  const recovery = createMysqlModelTaskRecovery(pool, createAccountInventorySummaryReader)
  const usage = createMysqlModelUsageLedger(pool, { principals: createModelPrincipals, active: createModelActive })
  const loop = new AsyncPollLoop(async () => {
    try {
      const now = new Date()
      await recovery.expireOverdue(now, config.modelRecoveryBatchSize)
      const recoveredUsage = await usage.recoverAbandoned(
        new Date(now.getTime() - config.modelUsageReservationMaxAgeMs), config.modelRecoveryBatchSize,
      )
      if (recoveredUsage > 0) {
        health.workFailed('model_usage_reservations_recovered')
        console.error('[scheduler-analysis] abandoned model usage recovered', recoveredUsage)
      }
      const result = await scheduler.tick(now, config.analysisScheduleBatchSize)
      const traderResult = await independentTraderScheduler.tick(now, config.analysisScheduleBatchSize)
      if (result.failures.length > 0) {
        health.workFailed('analysis_schedule_partial_failure')
        console.error('[scheduler-analysis] schedules failed', result.failures.length)
      } else if (traderResult.failures.length > 0) {
        health.workFailed('independent_trader_schedule_partial_failure')
        console.error('[scheduler-analysis] independent trader schedules failed', traderResult.failures.length)
      } else if (recoveredUsage === 0) health.workSucceeded()
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
