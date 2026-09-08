import type { Pool } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import { TradeHistoryService } from './application/trade-history-service.js'
import { MysqlTradeHistoryRepository } from './infrastructure/mysql-trade-history-repository.js'
import { tradeHistoryRoutes, type TradeHistoryRequestAuthenticator } from './transport/http/trade-history-routes.js'
import type { BridgeHistoryQueryClient } from '../bridge/index.js'
import { TradeHistoryCollector } from './application/trade-history-collector.js'
import { TradeHistoryScheduleService } from './application/trade-history-scheduler.js'
import { MysqlTradeHistoryCollectorRepository } from './infrastructure/mysql-trade-history-collector-repository.js'
import { MysqlTradeHistoryScheduleRepository } from './infrastructure/mysql-trade-history-schedule-repository.js'

export function createMysqlTradeHistoryCollector(pool: Pool, queries: BridgeHistoryQueryClient): Pick<TradeHistoryCollector, 'collect'> {
  return new TradeHistoryCollector(new MysqlTradeHistoryCollectorRepository(pool), queries)
}

export function createMysqlTradeHistoryScheduler(pool: Pool): Pick<TradeHistoryScheduleService, 'schedule'> {
  return new TradeHistoryScheduleService(new MysqlTradeHistoryScheduleRepository(pool))
}

export function createTradeHistoryHttp(service: TradeHistoryService, auth: TradeHistoryRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(tradeHistoryRoutes, { prefix: '/api/v4', service, auth }) }
}

export function createMysqlTradeHistoryHttp(pool: Pool, auth: TradeHistoryRequestAuthenticator): FastifyPluginAsync {
  return createTradeHistoryHttp(new TradeHistoryService(new MysqlTradeHistoryRepository(pool)), auth)
}
