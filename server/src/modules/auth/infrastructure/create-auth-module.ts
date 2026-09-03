import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import { AuthService } from '../application/auth-service.js'
import { BcryptPasswordVerifier } from './bcrypt-password-verifier.js'
import { createFirstPartyAuthClients } from './auth-client-registry.js'
import { MysqlAuthRepository } from './mysql-auth-repository.js'
import { MysqlBridgeDeviceRevoker } from './mysql-bridge-device-revoker.js'
import { RedisAuthTransientStore } from './redis-auth-transient-store.js'
import { Es256IdTokenSigner } from './es256-id-token-signer.js'

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

export function createAuthModule(pool: Pool, redis: Redis, config: AuthModuleConfig) {
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
    bridgeDeviceRevoker: new MysqlBridgeDeviceRevoker(pool),
    idTokenSigner: new Es256IdTokenSigner(config.idTokenPrivateKeyPem, config.idTokenKeyId),
  })
}
