import { referralRuleRoutes, type ReferralRuleManagementService } from '../modules/commerce/index.js'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../modules/auth/index.js'
import { bridgeCredentialRoutes, bridgePairingRoutes, type BridgeCredentialService, type BridgePairingService } from '../modules/bridge/index.js'
import {
  executionDistributionRoutes, executionRoutes, userExecutionCommandRoutes, type ExecutionDistributionService,
  type ExecutionService, type UserExecutionCommandService,
} from '../modules/execution/index.js'
import { riskRoutes, type RiskService } from '../modules/risk/index.js'
import {
  type TradeSessionAuthenticator, type ObserverManagementRequestAuthenticator,
} from '../modules/trading/index.js'

export interface ApiV4RouteServices {
  learningHttp?: FastifyPluginAsync
  auth: AuthService
  authHttp: FastifyPluginAsync
  bridgeCredentials: BridgeCredentialService
  bridgePairing: BridgePairingService
  tradingHttp: FastifyPluginAsync
  inferenceHttp: FastifyPluginAsync
  strategiesHttp: FastifyPluginAsync
  risk: RiskService
  reviewsHttp: FastifyPluginAsync
  execution: ExecutionService
  userExecution: UserExecutionCommandService
  executionDistribution: ExecutionDistributionService
  tradeHistoryHttp: FastifyPluginAsync
  auditHttp: FastifyPluginAsync
  tradeAuth: TradeSessionAuthenticator
  settingsHttp: FastifyPluginAsync
  referralRules: ReferralRuleManagementService
  observerManagementHttp: FastifyPluginAsync
  observerAdminAuth: ObserverManagementRequestAuthenticator
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
    await admin.register(services.settingsHttp)
    await admin.register(referralRuleRoutes, {
      prefix: '/api/v4/admin/referrals', service: services.referralRules, auth: services.observerAdminAuth,
    })
    await admin.register(services.observerManagementHttp)
  })
  await fastify.register(async trade => {
    trade.addHook('onRequest', exactTradeHostHook(input.tradeOrigin))
    await trade.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: services.bridgeCredentials })
    await trade.register(bridgePairingRoutes, { prefix: '/api/v4', service: services.bridgePairing, auth: services.tradeAuth })
    await trade.register(services.tradingHttp)
    await trade.register(services.inferenceHttp)
    await trade.register(services.strategiesHttp)
    await trade.register(riskRoutes, { prefix: '/api/v4', service: services.risk, auth: services.tradeAuth })
    await trade.register(services.reviewsHttp)
    await trade.register(executionRoutes, { prefix: '/api/v4', service: services.execution, auth: services.tradeAuth })
    await trade.register(userExecutionCommandRoutes, { prefix: '/api/v4', service: services.userExecution, auth: services.tradeAuth })
    await trade.register(executionDistributionRoutes, { prefix: '/api/v4', service: services.executionDistribution, auth: services.tradeAuth })
    await trade.register(services.tradeHistoryHttp)
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
