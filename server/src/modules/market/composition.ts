import type { Pool } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import { CalendarService } from './application/calendar-service.js'
import { MysqlCalendarReader } from './infrastructure/mysql-calendar-reader.js'
import { calendarRoutes, type CalendarHttpAuth } from './transport/http/calendar-routes.js'
import { MacroSeriesService } from './application/macro-series-service.js'
import { MysqlMacroSeriesReader } from './infrastructure/mysql-macro-series-reader.js'
import { MacroFreshnessPolicy } from './domain/macro-freshness.js'
import { macroSeriesRoutes } from './transport/http/macro-series-routes.js'
import { MacroSnapshotService } from './application/macro-snapshot-service.js'
import { MysqlPublicMacroSnapshotReader } from './infrastructure/mysql-public-macro-snapshot-reader.js'
import { macroSnapshotRoutes } from './transport/http/macro-snapshot-routes.js'

export function createCalendarService(executor: Pick<Pool, 'execute'>) { return new CalendarService(new MysqlCalendarReader(executor)) }
export function createMacroSeriesService(executor: Pick<Pool, 'execute'>) {
  return new MacroSeriesService(new MysqlMacroSeriesReader(executor), new MacroFreshnessPolicy())
}
export function createMacroSnapshotService(executor: Pick<Pool, 'execute'>, calendar: CalendarService) {
  return new MacroSnapshotService(new MysqlPublicMacroSnapshotReader(executor), calendar)
}
export function createMarketHttp(calendar: CalendarService, auth: CalendarHttpAuth, series: MacroSeriesService, snapshots: MacroSnapshotService): FastifyPluginAsync {
  return async app => {
    await app.register(calendarRoutes, { prefix: '/api/v4', service: calendar, auth })
    await app.register(macroSeriesRoutes, { prefix: '/api/v4', service: series, auth })
    await app.register(macroSnapshotRoutes, { prefix: '/api/v4', service: snapshots, auth })
  }
}
