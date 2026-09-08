import type { Pool, PoolConnection } from 'mysql2/promise'
import type { FastifyPluginAsync } from 'fastify'
import type { SettingReader } from './domain/setting-read.js'
import { validateSettingMenu } from './domain/setting-menu-policy.js'
import { AdminSettingReader } from './application/admin-setting-reader.js'
import { SettingManagementService } from './application/setting-management.js'
import { MysqlAdminSettingReader } from './infrastructure/mysql-admin-setting-reader.js'
import { MysqlSettingManagement } from './infrastructure/mysql-setting-management.js'
import { readSetting } from './infrastructure/mysql-setting-reader.js'
import { adminSettingReadRoutes } from './transport/http/admin-setting-read-routes.js'
import { settingRoutes } from './transport/http/setting-routes.js'

interface SettingsAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
}

export function createSettingReader(executor: Pick<PoolConnection, 'execute'>): SettingReader {
  return { read: input => readSetting(executor, input) }
}

export function createSettingsHttp(services: { read: AdminSettingReader; write: SettingManagementService }, auth: SettingsAuthenticator): FastifyPluginAsync {
  return async app => {
    await app.register(adminSettingReadRoutes, { prefix: '/api/v4/admin/settings', service: services.read, auth })
    await app.register(settingRoutes, { prefix: '/api/v4/admin/settings', service: services.write, auth })
  }
}

export function createMysqlSettingsModule(pool: Pick<Pool, 'getConnection'>, auth: SettingsAuthenticator) {
  const read = new AdminSettingReader(new MysqlAdminSettingReader(pool))
  const write = new SettingManagementService(new MysqlSettingManagement(pool, validateSettingMenu))
  return { read, write, http: createSettingsHttp({ read, write }, auth) }
}
