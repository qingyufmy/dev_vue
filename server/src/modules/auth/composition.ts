import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import type { FastifyPluginAsync } from 'fastify'
import { AuthService } from './application/auth-service.js'
import type { BridgeDeviceRevoker } from './application/auth-ports.js'
import { BcryptPasswordVerifier } from './infrastructure/bcrypt-password-verifier.js'
import { createFirstPartyAuthClients } from './infrastructure/auth-client-registry.js'
import { MysqlAuthRepository } from './infrastructure/mysql-auth-repository.js'
import { RedisAuthTransientStore } from './infrastructure/redis-auth-transient-store.js'
import { Es256IdTokenSigner } from './infrastructure/es256-id-token-signer.js'
import { RealtimeTicketAuthenticator } from './application/realtime-ticket-authenticator.js'
import { registerSsoRoutes } from './transport/http/register-sso-routes.js'
import type { BrowserRequestAccess } from './application/browser-request-access.js'
import { AuthTradeRequestAdapter } from './transport/http/trade-request-access.js'
import { AuthObserverAdminAdapter } from './transport/http/admin-request-access.js'
export { assertMysqlAccountPrincipalReadSchema as assertAccountPrincipalReadSchema } from './infrastructure/mysql-account-principal-schema.js'

export function createBrowserRequestAccess(service: AuthService): { trade: BrowserRequestAccess; admin: BrowserRequestAccess } {
  return { trade: new AuthTradeRequestAdapter(service), admin: new AuthObserverAdminAdapter(service) }
}

export function createAuthHttp(service: AuthService, secureCookies = true): FastifyPluginAsync {
  return async app => { await registerSsoRoutes(app, service, secureCookies) }
}

export interface AuthModuleConfig {
  authOrigin: string
  wwwOrigin: string
  tradeOrigin: string
  adminOrigin: string
  csrfSecret: string
  bffExchangeSecret: string
  idTokenPrivateKeyPem: string
  idTokenKeyId: string
}

export function createAuthModule(pool: Pool, redis: Redis, config: AuthModuleConfig, bridgeDeviceRevoker: BridgeDeviceRevoker) {
  if (config.csrfSecret.length < 32 || config.bffExchangeSecret.length < 32) {
    throw new Error('auth_secrets_too_short')
  }
  const transient = new RedisAuthTransientStore(redis)
  return new AuthService({
    issuer: new URL(config.authOrigin).origin,
    clients: createFirstPartyAuthClients(config),
    csrfSecret: config.csrfSecret,
    bffExchangeSecret: config.bffExchangeSecret,
    repository: new MysqlAuthRepository(pool),
    loginTransactions: transient,
    realtimeTickets: transient,
    passwordVerifier: new BcryptPasswordVerifier(),
    bridgeDeviceRevoker,
    idTokenSigner: new Es256IdTokenSigner(config.idTokenPrivateKeyPem, config.idTokenKeyId),
  })
}

export function createRealtimeTicketAuthenticator(pool: Pool, redis: Redis) {
  return new RealtimeTicketAuthenticator(
    new MysqlAuthRepository(pool),
    new RedisAuthTransientStore(redis),
  )
}
export { createMysqlActivePrincipalAccess as createActivePrincipalAccess } from './infrastructure/mysql-active-principal-access.js'
