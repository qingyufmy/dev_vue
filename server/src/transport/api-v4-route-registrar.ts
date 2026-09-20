import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService } from '../modules/auth/index.js'
import {
  type TradeSessionAuthenticator, type ObserverManagementRequestAuthenticator,
} from '../modules/trading/index.js'

export interface ApiV4RouteServices {
  learningHttp?: FastifyPluginAsync
  auth: AuthService
  authHttp: FastifyPluginAsync
  bridgeHttp: FastifyPluginAsync
  tradingHttp: FastifyPluginAsync
  marketHttp: FastifyPluginAsync
  inferenceHttp: FastifyPluginAsync
  strategiesHttp: FastifyPluginAsync
  platformStrategiesHttp?: FastifyPluginAsync
  riskHttp: FastifyPluginAsync
  reviewsHttp: FastifyPluginAsync
  executionHttp: FastifyPluginAsync
  tradeHistoryHttp: FastifyPluginAsync
  auditHttp: FastifyPluginAsync
  tradeAuth: TradeSessionAuthenticator
  settingsHttp: FastifyPluginAsync
  referralRulesHttp: FastifyPluginAsync
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
    if (services.platformStrategiesHttp) await admin.register(services.platformStrategiesHttp)
    await admin.register(services.settingsHttp)
    await admin.register(services.referralRulesHttp)
    await admin.register(services.observerManagementHttp)
  })
  await fastify.register(async trade => {
    trade.addHook('onRequest', exactTradeHostHook(input.tradeOrigin))
    await trade.register(services.bridgeHttp)
    await trade.register(services.tradingHttp)
    await trade.register(services.marketHttp)
    await trade.register(services.inferenceHttp)
    await trade.register(services.strategiesHttp)
    await trade.register(services.riskHttp)
    await trade.register(services.reviewsHttp)
    await trade.register(services.executionHttp)
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
