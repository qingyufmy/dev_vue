import { LearningService, MysqlLearningReader, LearningCompletionService, MysqlLearningCompletion } from '../modules/learning/index.js'
import { MysqlLearningMembershipReader } from '../modules/commerce/index.js'
import { validateSettingMenu,AdminSettingReader,MysqlAdminSettingReader,SettingManagementService,MysqlSettingManagement } from '../modules/settings/management.js'
import { ReferralRuleManagementService, MysqlReferralRuleManagement } from '../modules/commerce/index.js'
import Fastify from 'fastify'
import { createMysqlAuditModule } from '../modules/audit/composition.js'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4ApiRuntimeConfig, loadV4BaseRuntimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import { createAuthModule, createAuthHttp } from '../modules/auth/composition.js'
import { createBridgeDeviceRevoker } from '../modules/bridge/composition.js'
import {
  BridgeCredentialService, MysqlBridgeCredentialRepository, RedisBridgeGatewayLeaseStore, RedisBridgeSessionTicketStore,
  BridgePairingService, MysqlBridgePairingRepository,
} from '../modules/bridge/index.js'
import {
  ExecutionDistributionService, ExecutionService, MysqlExecutionDistributionRepository, MysqlExecutionRepository,
  MysqlUserExecutionCommandRepository, UserExecutionCommandService,
} from '../modules/execution/index.js'
import { InferenceService, MysqlInferenceRepository } from '../modules/inference/index.js'
import { MysqlRiskRepository, RiskService } from '../modules/risk/index.js'
import { MysqlReviewRepository, ReviewService } from '../modules/reviews/index.js'
import { MysqlStrategyCatalog, StrategyService } from '../modules/strategies/index.js'
import { MysqlTradeHistoryRepository, TradeHistoryService } from '../modules/trade-history/index.js'
import {
  AuthTradeRequestAdapter, ConnectionCapacityService, MysqlTradingRepository, RedisConnectionLeaseStore,
  TradingService, MysqlObserverAccessReader, ObserverPublicationService,
  ObserverManagementService, MysqlObserverManagementRepository, AuthObserverAdminAdapter,
} from '../modules/trading/index.js'
import { registerApiV4Routes } from '../transport/api-v4-route-registrar.js'

loadServerEnvironment()

async function main() {
  const runtime = loadV4BaseRuntimeConfig()
  const web = loadV4ApiRuntimeConfig()
  assertV4RuntimeEnabled(runtime)
  const health = new RoleHealth('api-v4')
  const pool = createMysqlPool(runtime.mysql)
  const cache = createCacheRedis(runtime.cacheRedis)
  await Promise.all([pool.query('SELECT 1'), connectCacheRedis(cache)])

  const auth = createAuthModule(pool, cache, web.auth, createBridgeDeviceRevoker(pool))
  const tradeAuth = new AuthTradeRequestAdapter(auth)
  const observerAccess = new MysqlObserverAccessReader(pool)
  const tradingRepository = new MysqlTradingRepository(pool, new RedisBridgeGatewayLeaseStore(cache), observerAccess)
  const userExecution = new UserExecutionCommandService(new MysqlUserExecutionCommandRepository(pool))
  const executionDistribution = new ExecutionDistributionService(new MysqlExecutionDistributionRepository(pool))
  const strategies = new StrategyService(new MysqlStrategyCatalog(pool))
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, trustProxy: true })
  await registerApiV4Routes(app, {
    auth,
    authHttp: createAuthHttp(auth, web.secureCookies),
    learning: new LearningService(new MysqlLearningReader(pool), new MysqlLearningMembershipReader(pool)),
    learningCompletion: new LearningCompletionService(new MysqlLearningCompletion(pool, MysqlLearningMembershipReader.forTransaction)),
    bridgePairing: new BridgePairingService(new MysqlBridgePairingRepository(pool)),
    bridgeCredentials: new BridgeCredentialService(
      new MysqlBridgeCredentialRepository(pool),
      new RedisBridgeSessionTicketStore(cache),
    ),
    trading: new TradingService(tradingRepository, new ObserverPublicationService(observerAccess, tradingRepository)),
    connectionCapacity: new ConnectionCapacityService(tradingRepository, new RedisConnectionLeaseStore(cache)),
    inference: new InferenceService(new MysqlInferenceRepository(pool), strategies),
    strategies,
    risk: new RiskService(new MysqlRiskRepository(pool)),
    reviews: new ReviewService(new MysqlReviewRepository(pool)),
    execution: new ExecutionService(new MysqlExecutionRepository(pool)),
    userExecution,
    executionDistribution,
    tradeHistory: new TradeHistoryService(new MysqlTradeHistoryRepository(pool)),
    auditHttp: createMysqlAuditModule(pool, tradeAuth).http,
    tradeAuth,
    settingReader: new AdminSettingReader(new MysqlAdminSettingReader(pool)),
    settings: new SettingManagementService(new MysqlSettingManagement(pool,validateSettingMenu)),
    referralRules: new ReferralRuleManagementService(new MysqlReferralRuleManagement(pool)),
    observerManagement: new ObserverManagementService(new MysqlObserverManagementRepository(pool)),
    observerAdminAuth: new AuthObserverAdminAdapter(auth),
  }, { wwwOrigin: web.auth.wwwOrigin, tradeOrigin: web.auth.tradeOrigin, adminOrigin: web.auth.adminOrigin, secureCookies: web.secureCookies })

  app.get('/health/live', async () => ({ status: 'ok', ...health.snapshot() }))
  app.get('/health/ready', async (_request, reply) => {
    const dependencies = await dependenciesReady(pool, cache)
    const snapshot = health.snapshot()
    const ready = dependencies && snapshot.accepting && snapshot.ready
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready', ...snapshot, dependencies_ready: dependencies })
  })
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
  try { await Promise.all([pool.query('SELECT 1'), cache.ping()]); return true } catch { return false }
}

void main().catch(error => {
  console.error('[api-v4] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
