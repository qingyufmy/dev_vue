import { createHmac } from 'node:crypto'
import {
  assertInternalNext,
  assertPkceChallenge,
  AuthError,
  cookieNameForClient,
  createOpaqueSecret,
  createPkceChallenge,
  hashSecret,
  secretsEqual,
} from '../domain/auth.js'
import type {
  AuthClient,
  AuthRepository,
  BridgeDeviceRevoker,
  LoginTransactionStore,
  IdTokenSigner,
  PasswordVerifier,
  RealtimeTicketStore,
  StoredSession,
} from './auth-ports.js'
import { RealtimeTicketAuthenticator } from './realtime-ticket-authenticator.js'

const AUTH_SESSION_SECONDS = 30 * 24 * 60 * 60
const CODE_TTL_SECONDS = 60
const LOGIN_TRANSACTION_TTL_SECONDS = 10 * 60
const REALTIME_TICKET_TTL_SECONDS = 30

export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  responseType: string
  scope: string
  state: string
  nonce: string
  codeChallenge: string
  codeChallengeMethod: string
}

export interface AuthServiceOptions {
  issuer: string
  clients: readonly AuthClient[]
  csrfSecret: string
  bffExchangeSecret: string
  repository: AuthRepository
  loginTransactions: LoginTransactionStore
  realtimeTickets: RealtimeTicketStore
  passwordVerifier: PasswordVerifier
  bridgeDeviceRevoker: BridgeDeviceRevoker
  idTokenSigner: IdTokenSigner
  now?: () => Date
}

export class AuthService {
  private readonly clientMap: ReadonlyMap<string, AuthClient>
  private readonly now: () => Date

  constructor(private readonly options: AuthServiceOptions) {
    this.clientMap = new Map(options.clients.map((client) => [client.clientId, client]))
    this.now = options.now ?? (() => new Date())
  }

  get issuer() { return this.options.issuer }
  get bffExchangeSecret() { return this.options.bffExchangeSecret }

  getClient(clientId: string) {
    const client = this.clientMap.get(clientId)
    if (!client) throw new AuthError('auth_client_invalid', 400)
    return client
  }

  clientForSurface(surface: string) {
    const client = this.options.clients.find((candidate) => candidate.surface === surface)
    if (!client) throw new AuthError('auth_surface_invalid', 400)
    return client
  }

  clientForHost(host: string | undefined) {
    const normalized = String(host ?? '').toLowerCase()
    const client = this.options.clients.find((candidate) => new URL(candidate.origin).host.toLowerCase() === normalized)
    if (!client) throw new AuthError('auth_surface_invalid', 400)
    return client
  }

  validateAuthorizationRequest(request: AuthorizationRequest) {
    const client = this.getClient(request.clientId)
    if (request.redirectUri !== client.redirectUri || request.responseType !== 'code') {
      throw new AuthError('auth_request_invalid', 400)
    }
    if (request.scope !== 'openid profile' || !/^[A-Za-z0-9_-]{24,128}$/.test(request.state)
      || !/^[A-Za-z0-9_-]{24,128}$/.test(request.nonce)) {
      throw new AuthError('auth_request_invalid', 400)
    }
    assertPkceChallenge(request.codeChallenge, request.codeChallengeMethod)
    return client
  }

  private async requireLoginTransaction(request: AuthorizationRequest) {
    const transaction = await this.options.loginTransactions.peekLogin(request.state)
    if (!transaction || transaction.clientId !== request.clientId || transaction.redirectUri !== request.redirectUri
      || transaction.nonce !== request.nonce
      || !secretsEqual(createPkceChallenge(transaction.codeVerifier), request.codeChallenge)) {
      throw new AuthError('auth_request_invalid', 400)
    }
    return transaction
  }

  private assertClientAccess(client: AuthClient, role: string, mfaLevel: StoredSession['mfaLevel']) {
    if (client.requiresAdmin && role !== 'admin') throw new AuthError('auth_admin_required', 403)
    const rank = { none: 0, otp: 1, strong: 2 } as const
    if (rank[mfaLevel] < rank[client.minimumMfaLevel]) throw new AuthError('auth_mfa_required', 403)
  }

  async startLogin(surface: string, nextInput?: string) {
    const client = this.clientForSurface(surface)
    const state = createOpaqueSecret('state').slice(0, 72)
    const nonce = createOpaqueSecret('nonce').slice(0, 72)
    const codeVerifier = createOpaqueSecret('pkce').slice(0, 72)
    const next = assertInternalNext(nextInput)
    const transaction = { state, nonce, codeVerifier, clientId: client.clientId, redirectUri: client.redirectUri, next }
    await this.options.loginTransactions.put(transaction, LOGIN_TRANSACTION_TTL_SECONDS)
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state,
      nonce,
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    })
    return `${this.options.issuer}/oauth/authorize?${query.toString()}`
  }

  async authenticate(login: string, password: string, remember: boolean) {
    const normalizedLogin = login.trim()
    if (!normalizedLogin || normalizedLogin.length > 255 || !password || password.length > 1024) {
      throw new AuthError('auth_credentials_invalid', 401)
    }
    const user = await this.options.repository.findUserByLogin(normalizedLogin)
    if (!user?.active || !await this.options.passwordVerifier.verify(password, user.passwordHash)) {
      throw new AuthError('auth_credentials_invalid', 401)
    }
    const now = this.now()
    const rawSession = createOpaqueSecret('as')
    const absoluteExpiresAtUtc = new Date(now.getTime() + (remember ? AUTH_SESSION_SECONDS : 8 * 60 * 60) * 1000)
    const session = await this.options.repository.createSession({
      sessionHash: hashSecret(rawSession),
      userId: user.id,
      clientId: 'auth',
      parentSessionId: null,
      authTimeUtc: now,
      mfaLevel: 'none',
      sessionVersion: user.sessionVersion,
      createdAtUtc: now,
      lastSeenAtUtc: now,
      idleExpiresAtUtc: null,
      absoluteExpiresAtUtc,
    })
    return { rawSession, session, user, remember }
  }

  async resolveSession(rawSession: string | undefined, expectedClientId: 'auth' | AuthClient['clientId']) {
    if (!rawSession) throw new AuthError('auth_session_required', 401)
    const now = this.now()
    const session = await this.options.repository.findActiveSession(hashSecret(rawSession), now)
    if (!session || session.clientId !== expectedClientId) throw new AuthError('auth_session_invalid', 401)
    const user = await this.options.repository.findUserById(session.userId)
    if (!user?.active || user.sessionVersion !== session.sessionVersion) {
      await this.options.repository.revokeSession(session.id, 'security_version_changed', now)
      throw new AuthError('auth_session_invalid', 401)
    }
    if (expectedClientId === 'admin-web' && user.role !== 'admin') {
      await this.options.repository.revokeSession(session.id, 'admin_role_required', now)
      throw new AuthError('auth_admin_required', 403)
    }
    const client = expectedClientId === 'auth' ? null : this.getClient(expectedClientId)
    const idleExpiresAtUtc = client?.sessionIdleSeconds
      ? new Date(Math.min(session.absoluteExpiresAtUtc.getTime(), now.getTime() + client.sessionIdleSeconds * 1000))
      : null
    await this.options.repository.touchSession(session.id, now, idleExpiresAtUtc, new Date(now.getTime() - 60_000))
    return { session, user }
  }

  async issueAuthorizationCode(request: AuthorizationRequest, rawAuthSession: string) {
    const client = this.validateAuthorizationRequest(request)
    await this.requireLoginTransaction(request)
    const { session, user } = await this.resolveSession(rawAuthSession, 'auth')
    this.assertClientAccess(client, user.role, session.mfaLevel)
    const code = createOpaqueSecret('code')
    const now = this.now()
    await this.options.repository.storeAuthorizationCode({
      codeHash: hashSecret(code),
      userId: user.id,
      authSessionId: session.id,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      scope: request.scope,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
      createdAtUtc: now,
      expiresAtUtc: new Date(now.getTime() + CODE_TTL_SECONDS * 1000),
    })
    const redirect = new URL(client.redirectUri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', request.state)
    return redirect.toString()
  }

  async finishLogin(request: AuthorizationRequest, login: string, password: string, remember: boolean) {
    this.validateAuthorizationRequest(request)
    await this.requireLoginTransaction(request)
    const authenticated = await this.authenticate(login, password, remember)
    try {
      const redirectTo = await this.issueAuthorizationCode(request, authenticated.rawSession)
      return { ...authenticated, redirectTo }
    } catch (error) {
      await this.options.repository.revokeSession(authenticated.session.id, 'authorization_failed', this.now())
      throw error
    }
  }

  async exchangeCode(input: { code: string; state: string; codeVerifier?: string; clientId: string; redirectUri: string }) {
    const transaction = await this.options.loginTransactions.consumeLogin(input.state)
    if (!transaction || transaction.clientId !== input.clientId || transaction.redirectUri !== input.redirectUri
      || (input.codeVerifier !== undefined && !secretsEqual(transaction.codeVerifier, input.codeVerifier))) {
      throw new AuthError('auth_callback_invalid', 400)
    }
    const client = this.getClient(input.clientId)
    const authorization = await this.options.repository.consumeAuthorizationCode(hashSecret(input.code), this.now())
    if (!authorization || authorization.clientId !== client.clientId || authorization.redirectUri !== client.redirectUri
      || !secretsEqual(authorization.nonce, transaction.nonce)
      || !secretsEqual(authorization.codeChallenge, createPkceChallenge(transaction.codeVerifier))) {
      throw new AuthError('auth_code_invalid', 400)
    }
    const user = await this.options.repository.findUserById(authorization.userId)
    if (!user?.active || user.sessionVersion !== authorization.sessionVersion) throw new AuthError('auth_code_invalid', 400)
    this.assertClientAccess(client, user.role, authorization.mfaLevel)
    const now = this.now()
    const rawSession = createOpaqueSecret('app')
    const session = await this.options.repository.createSession({
      sessionHash: hashSecret(rawSession),
      userId: user.id,
      clientId: client.clientId,
      parentSessionId: authorization.authSessionId,
      authTimeUtc: authorization.authTimeUtc,
      mfaLevel: authorization.mfaLevel,
      sessionVersion: authorization.sessionVersion,
      createdAtUtc: now,
      lastSeenAtUtc: now,
      idleExpiresAtUtc: client.sessionIdleSeconds ? new Date(now.getTime() + client.sessionIdleSeconds * 1000) : null,
      absoluteExpiresAtUtc: new Date(now.getTime() + client.sessionAbsoluteSeconds * 1000),
    })
    const issuedAtSeconds = Math.floor(now.getTime() / 1000)
    const idToken = await this.options.idTokenSigner.sign({
      issuer: this.options.issuer,
      audience: client.clientId,
      subject: String(user.id),
      nonce: authorization.nonce,
      authTimeSeconds: Math.floor(authorization.authTimeUtc.getTime() / 1000),
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + 60,
      mfaLevel: authorization.mfaLevel,
    })
    return { rawSession, session, user, next: transaction.next, client, idToken }
  }

  csrfToken(rawSession: string, session: StoredSession) {
    return createHmac('sha256', this.options.csrfSecret)
      .update(`${session.id}:${session.clientId}:${rawSession}`)
      .digest('base64url')
  }

  assertCsrf(rawSession: string, session: StoredSession, token: string | undefined, origin: string | undefined) {
    const client = this.getClient(session.clientId)
    if (origin !== client.origin || !token || !secretsEqual(token, this.csrfToken(rawSession, session))) {
      throw new AuthError('auth_csrf_invalid', 403)
    }
  }

  assertAuthCsrf(rawSession: string, session: StoredSession, token: string | undefined, origin: string | undefined) {
    const expectedOrigin = new URL(this.options.issuer).origin
    if (origin !== expectedOrigin || !token || !secretsEqual(token, this.csrfToken(rawSession, session))) {
      throw new AuthError('auth_csrf_invalid', 403)
    }
  }

  async sessionSummary(rawSession: string, clientId: AuthClient['clientId']) {
    const resolved = await this.resolveSession(rawSession, clientId)
    return {
      resolved,
      data: {
        user: {
          id: String(resolved.user.id),
          display_name: resolved.user.displayName,
          avatar_url: resolved.user.avatarUrl,
        },
        app: this.getClient(clientId).surface,
        permissions: resolved.user.role === 'admin' ? ['user', 'admin'] : ['user'],
        authenticated_at: resolved.session.authTimeUtc.toISOString(),
        mfa_level: resolved.session.mfaLevel,
        csrf_token: this.csrfToken(rawSession, resolved.session),
      },
    }
  }

  async issueRealtimeTicket(rawSession: string) {
    const { session } = await this.resolveSession(rawSession, 'trade-web')
    const ticket = createOpaqueSecret('rt')
    await this.options.realtimeTickets.issue(hashSecret(ticket), {
      userId: session.userId,
      sessionId: session.id,
      clientId: 'trade-web',
    }, REALTIME_TICKET_TTL_SECONDS)
    return {
      ticket,
      expiresAt: new Date(this.now().getTime() + REALTIME_TICKET_TTL_SECONDS * 1000),
      session,
    }
  }

  async consumeRealtimeTicket(rawTicket: string) {
    return new RealtimeTicketAuthenticator(
      this.options.repository,
      this.options.realtimeTickets,
      this.now,
    ).consume(rawTicket)
  }

  async logoutCurrent(session: StoredSession) {
    const now = this.now()
    await this.options.repository.revokeSession(session.id, 'logout_current_app', now)
    await this.options.realtimeTickets.revokeSession(session.id)
  }

  async logoutWeb(userId: number) {
    const now = this.now()
    await this.options.repository.revokeWebSessions(userId, 'logout_all_web', now)
    await this.options.realtimeTickets.revokeUser(userId)
  }

  async revokeAll(session: StoredSession) {
    const now = this.now()
    if (now.getTime() - session.authTimeUtc.getTime() > 5 * 60 * 1000) {
      throw new AuthError('auth_recent_auth_required', 403)
    }
    await this.options.bridgeDeviceRevoker.revokeUserDevices(session.userId, 'revoke_all_devices', now)
    await this.logoutWeb(session.userId)
  }

  cookieName(clientId: string) { return cookieNameForClient(clientId) }
  jwks() { return this.options.idTokenSigner.jwks() }
}
