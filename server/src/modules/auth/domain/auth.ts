import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type AppSurface = 'www' | 'trade' | 'admin'
export type MfaLevel = 'none' | 'otp' | 'strong'

export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(code)
    this.name = 'AuthError'
  }
}

export function createOpaqueSecret(prefix: string) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

export function hashSecret(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function createPkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function secretsEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function assertInternalNext(value: string | undefined, fallback = '/') {
  if (!value) return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new AuthError('auth_next_invalid', 400)
  }
  const parsed = new URL(value, 'https://local.invalid')
  if (parsed.origin !== 'https://local.invalid') throw new AuthError('auth_next_invalid', 400)
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

export function assertPkceChallenge(value: string, method: string) {
  if (method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AuthError('auth_pkce_invalid', 400)
  }
  return value
}

export function cookieNameForClient(clientId: string) {
  if (clientId === 'auth') return '__Host-Http-auth_session'
  if (clientId === 'www-web') return '__Host-Http-www_session'
  if (clientId === 'trade-web') return '__Host-Http-trade_session'
  if (clientId === 'admin-web') return '__Host-Http-admin_session'
  throw new AuthError('auth_client_invalid', 400)
}
