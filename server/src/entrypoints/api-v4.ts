import { notificationRoutes, createNotificationSettings } from '../modules/notifications/composition.js'
import { createTradeDecisionReapprovalWriter } from '../modules/inference/composition.js'
import { createModelSelection, modelSelectionRoutes, createModelConfiguration, modelConfigurationRoutes } from '../modules/inference/composition.js'
import { createMarketHistoryDemand } from '../modules/market/composition.js'
import { createPendingPreparationRuntime } from '../bootstrap/pending-preparation-runtime.js'
import { createAccountRiskSummaryReader } from '../modules/risk/composition.js'
import { createAccountInventorySummaryReader } from '../modules/trading/composition.js'
import { createSubscriptionExecutionWindowReader, createAnalysisSubscriberReader, createStrategyExecutionConfigReader } from '../modules/strategies/composition.js'
import { createTransactionRiskDecisionExecutionWriter } from '../modules/risk/composition.js'
import { createCalendarService, createMacroSnapshotService, createMacroSeriesService, createMarketHttp, createPublicMarketHttp } from '../modules/market/composition.js'
import { chanHistoryTarget, publicChanChart } from '../modules/market/index.js'
import { createBridgeHttp, createBridgeInstallationService, createBridgeInstallationHttp } from '../modules/bridge/composition.js'
import { createBridgeCredentialRepository, createBridgeGatewayLeases, createBridgeSessionTickets, createBridgePairingRepository } from '../modules/bridge/composition.js'
import { createAnalysisStrategyAccess } from '../modules/strategies/composition.js'
import { createAdminPrincipalAccess } from '../modules/auth/composition.js'
import { createAccountPrincipalReader, createMysqlMarketProviders } from '../modules/auth/composition.js'
import { createMysqlArchivedSignalReader, createMysqlMarketAnalysisList, createMysqlInferenceRepository, createInferenceHttp, createMysqlTradeDecisionRiskWriter } from '../modules/inference/composition.js'
import { createTransactionAccountClock, createMysqlInstrumentCollectionRequester, createMysqlInstrumentSnapshotReader } from '../modules/trading/composition.js'
import { createMysqlLearningService, createMysqlLearningCompletionService, createLearningHttp } from '../modules/learning/composition.js'
import { MysqlLearningMembershipReader, MysqlReferralRuleManagement, createReferralRuleHttp } from '../modules/commerce/composition.js'
import { createMysqlSettingsModule, createSettingReader } from '../modules/settings/composition.js'
import { PublicMarketCatalog } from '../modules/market/index.js'
import { ReferralRuleManagementService } from '../modules/commerce/index.js'
import Fastify from 'fastify'
import { createMysqlAuditModule } from '../modules/audit/composition.js'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4ApiRuntimeConfig, loadV4BaseRuntimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import { createAuthModule, createAuthHttp, createBrowserRequestAccess, assertAccountPrincipalReadSchemaV2, createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createBridgeDeviceRevoker, assertMysqlBridgeInstallationSchemaReady } from '../modules/bridge/composition.js'
import { BridgeCredentialService, BridgePairingService } from '../modules/bridge/index.js'
import {
  ExecutionDistributionService, ExecutionService, UserExecutionCommandService,
} from '../modules/execution/index.js'
import { InferenceService } from '../modules/inference/index.js'
import { createRiskService, createRiskHttp } from '../modules/risk/composition.js'
import { createMysqlArchivedExecutionReader, createExecutionHttp, MysqlExecutionDistributionRepository, MysqlExecutionRepository,
  MysqlUserExecutionCommandRepository } from '../modules/execution/composition.js'
import { createMysqlReviewHttp } from '../modules/reviews/composition.js'
import { createTransactionManualCandidateSourceVerifier } from '../bootstrap/manual-candidate-source-verifier.js'
import { createSubscriptionPreferencesReader, createMysqlStrategyService, createStrategyHttp, createPlatformStrategyHttp } from '../modules/strategies/composition.js'
import { createMysqlTradeHistoryHttp, assertMysqlTradeHistorySchemaReady } from '../modules/trade-history/composition.js'
import { assertTradingSchemaReady, createTradingApiModule, createTradingReader } from '../modules/trading/composition.js'
import { registerApiV4Routes } from '../transport/api-v4-route-registrar.js'

loadServerEnvironment()

async function main() {
  const runtime = loadV4BaseRuntimeConfig()
  const web = loadV4ApiRuntimeConfig()
  assertV4RuntimeEnabled(runtime)
  const health = new RoleHealth('api-v4')
  const pool = createMysqlPool(runtime.mysql)
  const cache = createCacheRedis(runtime.cacheRedis)
  await Promise.all([assertTradingSchemaReady(pool, assertAccountPrincipalReadSchemaV2), connectCacheRedis(cache)])
  await assertMysqlTradeHistorySchemaReady(pool)
  await assertMysqlBridgeInstallationSchemaReady(pool)

  const auth = createAuthModule(pool, cache, web.auth, createBridgeDeviceRevoker(pool))
  const trading = createTradingApiModule(pool, cache, createBrowserRequestAccess(auth, web.secureCookies), createBridgeGatewayLeases(cache), createActivePrincipalAccess, createAccountPrincipalReader, createAdminPrincipalAccess, createAnalysisStrategyAccess, {
    historyTarget: chanHistoryTarget,
    calculate: input => publicChanChart({ ...input, clock: null }),
  })
  const { tradeAuth, observerAdminAuth } = trading
  const userExecution = new UserExecutionCommandService(
    new MysqlUserExecutionCommandRepository(pool, createTransactionAccountClock, createMysqlInstrumentSnapshotReader(pool)),
    undefined,
    createMysqlInstrumentCollectionRequester(pool),
  )
  const executionDistribution = new ExecutionDistributionService(new MysqlExecutionDistributionRepository(pool))
  const strategies = createMysqlStrategyService(pool)
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, trustProxy: true })
  await registerApiV4Routes(app, {
    auth,
    authHttp: createAuthHttp(auth, web.secureCookies),
    learningHttp: createLearningHttp({
      read: createMysqlLearningService(pool, new MysqlLearningMembershipReader(pool)),
      completion: createMysqlLearningCompletionService(pool, MysqlLearningMembershipReader.forTransaction),
    }, auth, { wwwOrigin: web.auth.wwwOrigin, secureCookies: web.secureCookies }),
    bridgeHttp: async app => {
      await app.register(createBridgeHttp(
      new BridgeCredentialService(createBridgeCredentialRepository(pool), createBridgeSessionTickets(cache)),
      new BridgePairingService(createBridgePairingRepository(pool)), tradeAuth,
      ))
      await app.register(createBridgeInstallationHttp({ service: createBridgeInstallationService(pool, trading.connectionCapacity), auth: tradeAuth }))
    },
    tradingHttp: trading.tradeHttp,
    marketHttp: async app => {
      await app.register(createMarketHttp(createCalendarService(pool), tradeAuth, createMacroSeriesService(pool), createMacroSnapshotService(pool, createCalendarService(pool))))
      await app.register(createPublicMarketHttp(pool, createMysqlMarketProviders(pool), createTradingReader(pool, createBridgeGatewayLeases(cache), createAccountPrincipalReader), tradeAuth, new PublicMarketCatalog(createSettingReader(pool)), createMarketHistoryDemand(cache)))
    },
    inferenceHttp: async app => {
      await app.register(createInferenceHttp(new InferenceService(createMysqlInferenceRepository(pool, createTransactionAccountClock, createSubscriptionPreferencesReader, createSubscriptionExecutionWindowReader, { subscribers: createAnalysisSubscriberReader, inventory: createAccountInventorySummaryReader, risks: createAccountRiskSummaryReader }), strategies), tradeAuth, createMysqlMarketAnalysisList(pool), createMysqlArchivedSignalReader(pool)))
      await app.register(modelConfigurationRoutes, { prefix: '/api/v4', service: createModelConfiguration(pool, createAdminPrincipalAccess), auth: tradeAuth })
      await app.register(modelSelectionRoutes, { prefix: '/api/v4', service: createModelSelection(pool, createAccountPrincipalReader), auth: tradeAuth })
    },
    strategiesHttp: createStrategyHttp(strategies, tradeAuth, { pool, administrators: createAdminPrincipalAccess }),
    platformStrategiesHttp: createPlatformStrategyHttp(pool, strategies, observerAdminAuth, createAdminPrincipalAccess),
    riskHttp: createRiskHttp(createRiskService(pool, createMysqlTradeDecisionRiskWriter, createMysqlInstrumentSnapshotReader(pool)), tradeAuth),
    reviewsHttp: createMysqlReviewHttp(pool, tradeAuth, createTransactionManualCandidateSourceVerifier),
    executionHttp: createExecutionHttp(new ExecutionService(new MysqlExecutionRepository(pool, createTransactionAccountClock, createTransactionRiskDecisionExecutionWriter, createStrategyExecutionConfigReader, createPendingPreparationRuntime(createBridgeGatewayLeases(cache)), createTradeDecisionReapprovalWriter)),
      userExecution, executionDistribution, tradeAuth, createMysqlArchivedExecutionReader(pool)),
    tradeHistoryHttp: createMysqlTradeHistoryHttp(pool, tradeAuth, createMysqlArchivedExecutionReader(pool)),
    auditHttp: createMysqlAuditModule(pool, tradeAuth).http,
    tradeAuth,
    settingsHttp: createMysqlSettingsModule(pool, observerAdminAuth).http,
    referralRulesHttp: createReferralRuleHttp(new ReferralRuleManagementService(new MysqlReferralRuleManagement(pool)), observerAdminAuth),
    observerManagementHttp: trading.observerHttp,
    observerAdminAuth,
  }, { tradeOrigin: web.auth.tradeOrigin, adminOrigin: web.auth.adminOrigin })

  app.get('/health/live', async () => ({ status: 'ok', ...health.snapshot() }))
  app.get('/health/ready', async (_request, reply) => {
    const dependencies = await dependenciesReady(pool, cache)
    const snapshot = health.snapshot()
    const ready = dependencies && snapshot.accepting && snapshot.ready
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready', ...snapshot, dependencies_ready: dependencies })
  })
  await app.register(notificationRoutes, { prefix: '/api/v4', service: createNotificationSettings(pool), auth: tradeAuth })
  await app.listen({ host: runtime.host, port: web.port })
  health.setReady(true)
  health.setAccepting(true)

  installProcessLifecycle('api-v4', async () => {
    health.setAccepting(false)
    health.setReady(false)
    await app.close()
    await Promise.allSettled([cache.quit(), pool.end()])
  })
}

async function dependenciesReady(pool: ReturnType<typeof createMysqlPool>, cache: ReturnType<typeof createCacheRedis>) {
  try { await Promise.all([assertTradingSchemaReady(pool, assertAccountPrincipalReadSchemaV2), cache.ping()]); return true } catch { return false }
}

void main().catch(error => {
  console.error('[api-v4] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
