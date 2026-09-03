import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../../application/auth-service.js'
import { appSessionRoutes, authCenterRoutes } from './auth-routes.js'

export async function registerSsoRoutes(fastify: FastifyInstance, service: AuthService, secureCookies = true) {
  await fastify.register(authCenterRoutes, { service, secureCookies })
  await fastify.register(appSessionRoutes, { service, secureCookies })
}
