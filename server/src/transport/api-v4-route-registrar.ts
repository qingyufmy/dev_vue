import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { registerSsoRoutes, type AuthService } from '../modules/auth/index.js'
import { bridgeCredentialRoutes, type BridgeCredentialService } from '../modules/bridge/index.js'
import { executionRoutes, type ExecutionService } from '../modules/execution/index.js'
import { inferenceRoutes, type InferenceService } from '../modules/inference/index.js'
import { riskRoutes, type RiskService } from '../modules/risk/index.js'
import { type StrategyService } from '../modules/strategies/index.js'
import {
  tradingRoutes, type AuthTradeRequestAdapter, type ConnectionCapacityService, type TradingService,
} from '../modules/trading/index.js'

export interface ApiV4RouteServices {
  auth: AuthService
  bridgeCredentials: BridgeCredentialService
  trading: TradingService
  connectionCapacity: ConnectionCapacityService
  inference: InferenceService
  strategies: StrategyService
  risk: RiskService
  execution: ExecutionService
  tradeAuth: AuthTradeRequestAdapter
}

export async function registerApiV4Routes(
  fastify: FastifyInstance,
  services: ApiV4RouteServices,
  input: { tradeOrigin: string; secureCookies: boolean },
) {
  await registerSsoRoutes(fastify, services.auth, input.secureCookies)
  await fastify.register(async trade => {
    trade.addHook('onRequest', exactTradeHostHook(input.tradeOrigin))
    await trade.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: services.bridgeCredentials })
    await trade.register(tradingRoutes, { prefix: '/api/v4', service: services.trading, capacity: services.connectionCapacity, auth: services.tradeAuth })
    await trade.register(inferenceRoutes, { prefix: '/api/v4', service: services.inference, strategies: services.strategies, auth: services.tradeAuth })
    await trade.register(riskRoutes, { prefix: '/api/v4', service: services.risk, auth: services.tradeAuth })
    await trade.register(executionRoutes, { prefix: '/api/v4', service: services.execution, auth: services.tradeAuth })
  })
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
