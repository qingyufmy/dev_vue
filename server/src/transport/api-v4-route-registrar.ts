import { settingRoutes,adminSettingReadRoutes,type AdminSettingReader,type SettingManagementService } from '../modules/settings/management.js'
import { referralRuleRoutes, type ReferralRuleManagementService } from '../modules/commerce/index.js'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../modules/auth/index.js'
import { bridgeCredentialRoutes, bridgePairingRoutes, type BridgeCredentialService, type BridgePairingService } from '../modules/bridge/index.js'
import {
  executionDistributionRoutes, executionRoutes, userExecutionCommandRoutes, type ExecutionDistributionService,
  type ExecutionService, type UserExecutionCommandService,
} from '../modules/execution/index.js'
import { inferenceRoutes, type InferenceService } from '../modules/inference/index.js'
import { riskRoutes, type RiskService } from '../modules/risk/index.js'
import { reviewRoutes, type ReviewService } from '../modules/reviews/index.js'
import { strategyRoutes, type StrategyService } from '../modules/strategies/index.js'
import { tradeHistoryRoutes, type TradeHistoryService } from '../modules/trade-history/index.js'
import {
  tradingRoutes, type AuthTradeRequestAdapter, type ConnectionCapacityService, type TradingService,
  observerManagementRoutes, type ObserverManagementService, type AuthObserverAdminAdapter,
} from '../modules/trading/index.js'

export interface ApiV4RouteServices {
  learningHttp?: FastifyPluginAsync
  auth: AuthService
  authHttp: FastifyPluginAsync
  bridgeCredentials: BridgeCredentialService
  bridgePairing: BridgePairingService
  trading: TradingService
  connectionCapacity: ConnectionCapacityService
  inference: InferenceService
  strategies: StrategyService
  risk: RiskService
  reviews: ReviewService
  execution: ExecutionService
  userExecution: UserExecutionCommandService
  executionDistribution: ExecutionDistributionService
  tradeHistory: TradeHistoryService
  auditHttp: FastifyPluginAsync
  tradeAuth: AuthTradeRequestAdapter
  settingReader: AdminSettingReader
  settings: SettingManagementService
  referralRules: ReferralRuleManagementService
  observerManagement: ObserverManagementService
  observerAdminAuth: AuthObserverAdminAdapter
}

export async function registerApiV4Routes(
  fastify: FastifyInstance,
  services: ApiV4RouteServices,
  input: { tradeOrigin: string; adminOrigin: string },
) {
  if (services.learningHttp) await fastify.register(services.learningHttp)
  await fastify.register(services.authHttp)
  await fastify.register(async admin => {
    admin.addHook('onRequest', exactAdminHostHook(input.adminOrigin))
    await admin.register(adminSettingReadRoutes, { prefix:'/api/v4/admin/settings', service:services.settingReader, auth:services.observerAdminAuth })
    await admin.register(settingRoutes, { prefix:'/api/v4/admin/settings', service:services.settings, auth:services.observerAdminAuth })
    await admin.register(referralRuleRoutes, {
      prefix: '/api/v4/admin/referrals', service: services.referralRules, auth: services.observerAdminAuth,
    })
    await admin.register(observerManagementRoutes, {
      prefix: '/api/v4/admin/observer', service: services.observerManagement, auth: services.observerAdminAuth,
    })
  })
  await fastify.register(async trade => {
    trade.addHook('onRequest', exactTradeHostHook(input.tradeOrigin))
    await trade.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: services.bridgeCredentials })
    await trade.register(bridgePairingRoutes, { prefix: '/api/v4', service: services.bridgePairing, auth: services.tradeAuth })
    await trade.register(tradingRoutes, { prefix: '/api/v4', service: services.trading, capacity: services.connectionCapacity, auth: services.tradeAuth })
    await trade.register(inferenceRoutes, { prefix: '/api/v4', service: services.inference, strategies: services.strategies, auth: services.tradeAuth })
    await trade.register(strategyRoutes, { prefix: '/api/v4', service: services.strategies, auth: services.tradeAuth })
    await trade.register(riskRoutes, { prefix: '/api/v4', service: services.risk, auth: services.tradeAuth })
    await trade.register(reviewRoutes, { prefix: '/api/v4', service: services.reviews, auth: services.tradeAuth })
    await trade.register(executionRoutes, { prefix: '/api/v4', service: services.execution, auth: services.tradeAuth })
    await trade.register(userExecutionCommandRoutes, { prefix: '/api/v4', service: services.userExecution, auth: services.tradeAuth })
    await trade.register(executionDistributionRoutes, { prefix: '/api/v4', service: services.executionDistribution, auth: services.tradeAuth })
    await trade.register(tradeHistoryRoutes, { prefix: '/api/v4', service: services.tradeHistory, auth: services.tradeAuth })
    await trade.register(services.auditHttp, { prefix: '/api/v4' })
  })
}

export function exactAdminHostHook(adminOrigin: string) {
  const expected = new URL(adminOrigin).host.toLowerCase()
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (String(request.headers.host ?? '').toLowerCase() === expected) return
    return reply.code(421).send({
      type: 'urn:aurum:problem:admin_host_required', title: 'Admin application host required', status: 421,
      code: 'admin_host_required', detail: 'admin_host_required', instance: request.url,
      correlation_id: request.id, retryable: false,
    })
  }
}

export function exactTradeHostHook(tradeOrigin: string) {
  const expected = new URL(tradeOrigin).host.toLowerCase()
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (String(request.headers.host ?? '').toLowerCase() === expected) return
    return reply.code(421).send({
      type: 'urn:aurum:problem:trade_host_required',
      title: 'Trade application host required',
      status: 421,
      code: 'trade_host_required',
      detail: 'trade_host_required',
      instance: request.url,
      correlation_id: request.id,
      retryable: false,
    })
  }
}
