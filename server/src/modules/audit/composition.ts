import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'mysql2/promise'
import { AuditService } from './application/audit-service.js'
import type { AuditRepository } from './application/audit-ports.js'
import { MysqlAuditRepository } from './infrastructure/mysql-audit-repository.js'
import { auditRoutes, type AuditRequestAuthenticator } from './transport/http/audit-routes.js'

export function createAuditModule(repository: AuditRepository, auth: AuditRequestAuthenticator, now?: () => Date) {
  const service = new AuditService(repository, now)
  const http: FastifyPluginAsync = async app => { await app.register(auditRoutes, { service, auth }) }
  return { service, http }
}

export function createMysqlAuditModule(pool: Pool, auth: AuditRequestAuthenticator) {
  return createAuditModule(new MysqlAuditRepository(pool), auth)
}
