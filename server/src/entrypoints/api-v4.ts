import { createTransactionAccountClock } from '../modules/trading/composition.js'
import { createMysqlLearningService, createMysqlLearningCompletionService, createLearningHttp } from '../modules/learning/composition.js'
import { MysqlLearningMembershipReader } from '../modules/commerce/index.js'
import { createMysqlSettingsModule } from '../modules/settings/composition.js'
import { ReferralRuleManagementService, MysqlReferralRuleManagement } from '../modules/commerce/index.js'
import Fastify from 'fastify'
import { createMysqlAuditModule } from '../modules/audit/composition.js'
import {
  assertV4RuntimeEnabled, connectCacheRedis, createCacheRedis, createMysqlPool, installProcessLifecycle,
  loadServerEnvironment, loadV4ApiRuntimeConfig, loadV4BaseRuntimeConfig, RoleHealth,
} from '../bootstrap/index.js'
import { createAuthModule, createAuthHttp, createBrowserRequestAccess, assertAccountPrincipalReadSchema, createActivePrincipalAccess } from '../modules/auth/composition.js'
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
import { createMysqlTradeHistoryHttp } from '../modules/trade-history/composition.js'
import { assertTradingSchemaReady, createTradingApiModule } from '../modules/trading/composition.js'
import { registerApiV4Routes } from '../transport/api-v4-route-registrar.js'

loadServerEnvironment()

async function main() {
  const runtime = loadV4BaseRuntimeConfig()
  const web = loadV4ApiRuntimeConfig()
  assertV4RuntimeEnabled(runtime)
  const health = new RoleHealth('api-v4')
  const pool = createMysqlPool(runtime.mysql)
  const cache = createCacheRedis(runtime.cacheRedis)
  await Promise.all([assertTradingSchemaReady(pool, assertAccountPrincipalReadSchema), connectCacheRedis(cache)])

  const auth = createAuthModule(pool, cache, web.auth, createBridgeDeviceRevoker(pool))
  const trading = createTradingApiModule(pool, cache, createBrowserRequestAccess(auth), new RedisBridgeGatewayLeaseStore(cache), createActivePrincipalAccess)
  const { tradeAuth, observerAdminAuth } = trading
  const userExecution = new UserExecutionCommandService(new MysqlUserExecutionCommandRepository(pool, createTransactionAccountClock))
  const executionDistribution = new ExecutionDistributionService(new MysqlExecutionDistributionRepository(pool))
  const strategies = new StrategyService(new MysqlStrategyCatalog(pool))
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, trustProxy: true })
  await registerApiV4Routes(app, {
    auth,
    authHttp: createAuthHttp(auth, web.secureCookies),
    learningHttp: createLearningHttp({
      read: createMysqlLearningService(pool, new MysqlLearningMembershipReader(pool)),
      completion: createMysqlLearningCompletionService(pool, MysqlLearningMembershipReader.forTransaction),
    }, auth, { wwwOrigin: web.auth.wwwOrigin, secureCookies: web.secureCookies }),
    bridgePairing: new BridgePairingService(new MysqlBridgePairingRepository(pool)),
    bridgeCredentials: new BridgeCredentialService(
      new MysqlBridgeCredentialRepository(pool),
      new RedisBridgeSessionTicketStore(cache),
    ),
    tradingHttp: trading.tradeHttp,
    inference: new InferenceService(new MysqlInferenceRepository(pool, createTransactionAccountClock), strategies),
    strategies,
    risk: new RiskService(new MysqlRiskRepository(pool)),
    reviews: new ReviewService(new MysqlReviewRepository(pool)),
    execution: new ExecutionService(new MysqlExecutionRepository(pool, createTransactionAccountClock)),
    userExecution,
    executionDistribution,
    tradeHistoryHttp: createMysqlTradeHistoryHttp(pool, tradeAuth),
    auditHttp: createMysqlAuditModule(pool, tradeAuth).http,
    tradeAuth,
    settingsHttp: createMysqlSettingsModule(pool, observerAdminAuth).http,
    referralRules: new ReferralRuleManagementService(new MysqlReferralRuleManagement(pool)),
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
  try { await Promise.all([assertTradingSchemaReady(pool, assertAccountPrincipalReadSchema), cache.ping()]); return true } catch { return false }
}

void main().catch(error => {
  console.error('[api-v4] startup failed', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
