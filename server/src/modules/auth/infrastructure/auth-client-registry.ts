import type { AuthClient } from '../application/auth-ports.js'

export interface FirstPartyOriginConfig {
  authOrigin: string
  wwwOrigin: string
  tradeOrigin: string
  adminOrigin: string
}

function exactOrigin(value: string) {
  const url = new URL(value)
  if (url.pathname !== '/' || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('auth_origin_config_invalid')
  }
  return url.origin
}

export function createFirstPartyAuthClients(config: FirstPartyOriginConfig): readonly AuthClient[] {
  const wwwOrigin = exactOrigin(config.wwwOrigin)
  const tradeOrigin = exactOrigin(config.tradeOrigin)
  const adminOrigin = exactOrigin(config.adminOrigin)
  if (new Set([wwwOrigin, tradeOrigin, adminOrigin]).size !== 3) throw new Error('auth_origins_must_be_distinct')
  return [
    {
      clientId: 'www-web', surface: 'www', origin: wwwOrigin,
      redirectUri: `${wwwOrigin}/auth/callback`, requiresAdmin: false, minimumMfaLevel: 'none',
      sessionIdleSeconds: null, sessionAbsoluteSeconds: 7 * 24 * 60 * 60,
    },
    {
      clientId: 'trade-web', surface: 'trade', origin: tradeOrigin,
      redirectUri: `${tradeOrigin}/auth/callback`, requiresAdmin: false, minimumMfaLevel: 'none',
      sessionIdleSeconds: null, sessionAbsoluteSeconds: 7 * 24 * 60 * 60,
    },
    {
      clientId: 'admin-web', surface: 'admin', origin: adminOrigin,
      redirectUri: `${adminOrigin}/auth/callback`, requiresAdmin: true, minimumMfaLevel: 'none',
      sessionIdleSeconds: 30 * 60, sessionAbsoluteSeconds: 8 * 60 * 60,
    },
  ]
}
