import type { Pool } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import { TradeHistoryService } from './application/trade-history-service.js'
import { MysqlTradeHistoryRepository } from './infrastructure/mysql-trade-history-repository.js'
import { tradeHistoryRoutes, type TradeHistoryRequestAuthenticator } from './transport/http/trade-history-routes.js'

export function createTradeHistoryHttp(service: TradeHistoryService, auth: TradeHistoryRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(tradeHistoryRoutes, { prefix: '/api/v4', service, auth }) }
}

export function createMysqlTradeHistoryHttp(pool: Pool, auth: TradeHistoryRequestAuthenticator): FastifyPluginAsync {
  return createTradeHistoryHttp(new TradeHistoryService(new MysqlTradeHistoryRepository(pool)), auth)
}
