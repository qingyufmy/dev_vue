import type { AppSurface, MfaLevel } from '../domain/auth.js'

export interface AuthClient {
  clientId: 'www-web' | 'trade-web' | 'admin-web'
  surface: AppSurface
  redirectUri: string
  origin: string
  requiresAdmin: boolean
  minimumMfaLevel: MfaLevel
  sessionIdleSeconds: number | null
  sessionAbsoluteSeconds: number
}

export interface AuthUser {
  id: number
  displayName: string
  avatarUrl: string | null
  role: string
  passwordHash: string
  sessionVersion: number
  active: boolean
}

export interface StoredSession {
  id: number
  userId: number
  clientId: 'auth' | AuthClient['clientId']
  parentSessionId: number | null
  authTimeUtc: Date
  mfaLevel: MfaLevel
  sessionVersion: number
  idleExpiresAtUtc: Date | null
  absoluteExpiresAtUtc: Date
  revokedAtUtc: Date | null
}

export interface CreateSessionInput extends Omit<StoredSession, 'id' | 'revokedAtUtc'> {
  sessionHash: string
  createdAtUtc: Date
  lastSeenAtUtc: Date
}

export interface AuthorizationCodeInput {
  codeHash: string
  userId: number
  authSessionId: number
  clientId: AuthClient['clientId']
  redirectUri: string
  scope: string
  nonce: string
  codeChallenge: string
  createdAtUtc: Date
  expiresAtUtc: Date
}

export interface ConsumedAuthorizationCode extends AuthorizationCodeInput {
  id: number
  authTimeUtc: Date
  mfaLevel: MfaLevel
  sessionVersion: number
}

export interface AuthRepository {
  findUserByLogin(login: string): Promise<AuthUser | null>
  findUserById(userId: number): Promise<AuthUser | null>
  createSession(input: CreateSessionInput): Promise<StoredSession>
  findActiveSession(sessionHash: string, now: Date): Promise<StoredSession | null>
  findActiveSessionById(sessionId: number, now: Date): Promise<StoredSession | null>
  touchSession(sessionId: number, now: Date, idleExpiresAtUtc: Date | null, touchBeforeUtc: Date): Promise<void>
  revokeSession(sessionId: number, reason: string, now: Date): Promise<void>
  revokeWebSessions(userId: number, reason: string, now: Date): Promise<void>
  storeAuthorizationCode(input: AuthorizationCodeInput): Promise<void>
  consumeAuthorizationCode(codeHash: string, now: Date): Promise<ConsumedAuthorizationCode | null>
}

export interface LoginTransaction {
  state: string
  nonce: string
  codeVerifier: string
  clientId: AuthClient['clientId']
  redirectUri: string
  next: string
}

export interface LoginTransactionStore {
  put(transaction: LoginTransaction, ttlSeconds: number): Promise<void>
  peekLogin(state: string): Promise<LoginTransaction | null>
  consumeLogin(state: string): Promise<LoginTransaction | null>
}

export interface RealtimeTicketClaims {
  userId: number
  sessionId: number
  clientId: 'trade-web'
}

export interface RealtimeTicketStore {
  issue(ticketHash: string, claims: RealtimeTicketClaims, ttlSeconds: number): Promise<void>
  consumeTicket(ticketHash: string): Promise<RealtimeTicketClaims | null>
  revokeSession(sessionId: number): Promise<void>
  revokeUser(userId: number): Promise<void>
}

export interface BridgeDeviceRevoker {
  revokeUserDevices(userId: number, reason: string, now: Date): Promise<void>
}

export interface PasswordVerifier {
  verify(password: string, passwordHash: string): Promise<boolean>
}

export interface IdTokenClaims {
  issuer: string
  audience: AuthClient['clientId']
  subject: string
  nonce: string
  authTimeSeconds: number
  issuedAtSeconds: number
  expiresAtSeconds: number
  mfaLevel: MfaLevel
}

export interface IdTokenSigner {
  sign(claims: IdTokenClaims): Promise<string>
  jwks(): { keys: Array<Record<string, unknown>> }
}
