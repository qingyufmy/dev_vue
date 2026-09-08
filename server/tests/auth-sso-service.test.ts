import Fastify from 'fastify'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { createRequire } from 'node:module'
import { LearningService, learningRoutes, LearningCompletionService, learningCompletionRoutes } from '../src/modules/learning/index.js'
import { generateKeyPairSync, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  AuthError,
  AuthService,
  Es256IdTokenSigner,
  appSessionRoutes,
  authCenterRoutes,
  hashSecret,
  registerSsoRoutes,
} from '../src/modules/auth/index.js'
import type {
  AuthClient,
  AuthRepository,
  AuthUser,
  AuthorizationCodeInput,
  BridgeDeviceRevoker,
  ConsumedAuthorizationCode,
  CreateSessionInput,
  LoginTransaction,
  LoginTransactionStore,
  RealtimeTicketClaims,
  RealtimeTicketStore,
  StoredSession,
} from '../src/modules/auth/index.js'

const clients: AuthClient[] = [
  {
    clientId: 'www-web', surface: 'www', redirectUri: 'https://www.example.test/auth/callback',
    origin: 'https://www.example.test', requiresAdmin: false, minimumMfaLevel: 'none',
    sessionIdleSeconds: null, sessionAbsoluteSeconds: 604800,
  },
  {
    clientId: 'trade-web', surface: 'trade', redirectUri: 'https://trade.example.test/auth/callback',
    origin: 'https://trade.example.test', requiresAdmin: false, minimumMfaLevel: 'none',
    sessionIdleSeconds: null, sessionAbsoluteSeconds: 604800,
  },
  {
    clientId: 'admin-web', surface: 'admin', redirectUri: 'https://admin.example.test/auth/callback',
    origin: 'https://admin.example.test', requiresAdmin: true, minimumMfaLevel: 'none',
    sessionIdleSeconds: 1800, sessionAbsoluteSeconds: 28800,
  },
]

class MemoryAuthRepository implements AuthRepository {
  users = new Map<number, AuthUser>([
    [7, { id: 7, displayName: '测试交易者', avatarUrl: null, role: 'user', passwordHash: 'valid', sessionVersion: 3, active: true }],
    [1, { id: 1, displayName: '管理员', avatarUrl: null, role: 'admin', passwordHash: 'valid', sessionVersion: 4, active: true }],
  ])
  sessions: Array<StoredSession & { sessionHash: string }> = []
  codes: Array<AuthorizationCodeInput & { id: number; consumedAtUtc: Date | null }> = []
  nextSessionId = 1

  async findUserByLogin(login: string) {
    if (login === 'user@example.test') return this.users.get(7) ?? null
    if (login === 'admin@example.test') return this.users.get(1) ?? null
    return null
  }
  async findUserById(userId: number) { return this.users.get(userId) ?? null }
  async createSession(input: CreateSessionInput) {
    const session = { ...input, id: this.nextSessionId++, revokedAtUtc: null }
    this.sessions.push(session)
    return session
  }
  async findActiveSession(sessionHash: string, now: Date) {
    return this.sessions.find((session) => session.sessionHash === sessionHash && !session.revokedAtUtc
      && session.absoluteExpiresAtUtc > now && (!session.idleExpiresAtUtc || session.idleExpiresAtUtc > now)) ?? null
  }
  async findActiveSessionById(sessionId: number, now: Date) {
    return this.sessions.find((session) => session.id === sessionId && !session.revokedAtUtc
      && session.absoluteExpiresAtUtc > now && (!session.idleExpiresAtUtc || session.idleExpiresAtUtc > now)) ?? null
  }
  async touchSession() {}
  async revokeSession(sessionId: number, _reason: string, now: Date) {
    const session = this.sessions.find((item) => item.id === sessionId)
    if (session) session.revokedAtUtc = now
  }
  async revokeWebSessions(userId: number, _reason: string, now: Date) {
    for (const session of this.sessions.filter((item) => item.userId === userId)) session.revokedAtUtc = now
  }
  async storeAuthorizationCode(input: AuthorizationCodeInput) {
    this.codes.push({ ...input, id: this.codes.length + 1, consumedAtUtc: null })
  }
  async consumeAuthorizationCode(codeHash: string, now: Date): Promise<ConsumedAuthorizationCode | null> {
    const code = this.codes.find((item) => item.codeHash === codeHash && !item.consumedAtUtc && item.expiresAtUtc > now)
    if (!code) return null
    const authSession = this.sessions.find((item) => item.id === code.authSessionId && !item.revokedAtUtc)
    if (!authSession) return null
    code.consumedAtUtc = now
    return {
      id: code.id,
      codeHash: code.codeHash,
      userId: code.userId,
      authSessionId: code.authSessionId,
      clientId: code.clientId,
      redirectUri: code.redirectUri,
      scope: code.scope,
      nonce: code.nonce,
      codeChallenge: code.codeChallenge,
      createdAtUtc: code.createdAtUtc,
      expiresAtUtc: code.expiresAtUtc,
      authTimeUtc: authSession.authTimeUtc,
      mfaLevel: authSession.mfaLevel,
      sessionVersion: authSession.sessionVersion,
    }
  }
}

class MemoryTransientStore implements LoginTransactionStore, RealtimeTicketStore {
  logins = new Map<string, LoginTransaction>()
  tickets = new Map<string, RealtimeTicketClaims>()
  async put(transaction: LoginTransaction) { this.logins.set(transaction.state, transaction) }
  async peekLogin(state: string) { return this.logins.get(state) ?? null }
  async consumeLogin(state: string) {
    const value = this.logins.get(state) ?? null
    this.logins.delete(state)
    return value
  }
  async issue(ticketHash: string, claims: RealtimeTicketClaims) { this.tickets.set(ticketHash, claims) }
  async consumeTicket(ticketHash: string) {
    const value = this.tickets.get(ticketHash) ?? null
    this.tickets.delete(ticketHash)
    return value
  }
  async revokeSession(sessionId: number) {
    for (const [key, value] of this.tickets) if (value.sessionId === sessionId) this.tickets.delete(key)
  }
  async revokeUser(userId: number) {
    for (const [key, value] of this.tickets) if (value.userId === userId) this.tickets.delete(key)
  }
}

class MemoryBridgeRevoker implements BridgeDeviceRevoker {
  revokedUsers: number[] = []
  async revokeUserDevices(userId: number) { this.revokedUsers.push(userId) }
}

function fixture() {
  const repository = new MemoryAuthRepository()
  const transient = new MemoryTransientStore()
  const bridge = new MemoryBridgeRevoker()
  const service = new AuthService({
    issuer: 'https://auth.example.test', clients, csrfSecret: 'csrf-secret', bffExchangeSecret: 'bff-secret',
    repository, loginTransactions: transient, realtimeTickets: transient, bridgeDeviceRevoker: bridge,
    passwordVerifier: { verify: async (password, hash) => password === 'correct-password' && hash === 'valid' },
    idTokenSigner: {
      sign: async (claims) => `signed.${claims.audience}.${claims.subject}`,
      jwks: () => ({ keys: [{ kty: 'EC', kid: 'test-key', alg: 'ES256' }] }),
    },
  })
  return { service, repository, transient, bridge }
}

function oauthFields(url: string) {
  const parsed = new URL(url)
  return Object.fromEntries(parsed.searchParams.entries())
}

describe('SSO V4 service', () => {
  it('keeps exact redirect, S256 PKCE and internal next in a single-use login transaction', async () => {
    const { service, transient } = fixture()
    const authorizeUrl = await service.startLogin('trade', '/analyst?signal_id=9')
    const fields = oauthFields(authorizeUrl)
    expect(authorizeUrl.startsWith('https://auth.example.test/oauth/authorize?')).toBe(true)
    expect(fields).toMatchObject({
      client_id: 'trade-web', redirect_uri: 'https://trade.example.test/auth/callback',
      response_type: 'code', scope: 'openid profile', code_challenge_method: 'S256',
    })
    expect(fields.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(transient.logins.get(fields.state!)?.next).toBe('/analyst?signal_id=9')
    await expect(service.startLogin('trade', '//evil.example/')).rejects.toMatchObject({ code: 'auth_next_invalid' })
  })

  it('creates isolated app sessions and consumes authorization code and realtime ticket once', async () => {
    const { service, repository, transient } = fixture()
    const authorizeUrl = await service.startLogin('trade', '/')
    const fields = oauthFields(authorizeUrl)
    const login = await service.finishLogin({
      clientId: fields.client_id!, redirectUri: fields.redirect_uri!, responseType: fields.response_type!,
      scope: fields.scope!, state: fields.state!, nonce: fields.nonce!, codeChallenge: fields.code_challenge!,
      codeChallengeMethod: fields.code_challenge_method!,
    }, 'user@example.test', 'correct-password', false)
    const callback = new URL(login.redirectTo)
    const app = await service.exchangeCode({
      code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')!,
      clientId: 'trade-web', redirectUri: 'https://trade.example.test/auth/callback',
    })
    expect(app.session.clientId).toBe('trade-web')
    await expect(service.resolveSession(app.rawSession, 'www-web')).rejects.toMatchObject({ code: 'auth_session_invalid' })
    await expect(service.exchangeCode({
      code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')!,
      clientId: 'trade-web', redirectUri: 'https://trade.example.test/auth/callback',
    })).rejects.toMatchObject({ code: 'auth_callback_invalid' })

    const issued = await service.issueRealtimeTicket(app.rawSession)
    expect(await service.consumeRealtimeTicket(issued.ticket)).toMatchObject({ userId: 7, clientId: 'trade-web' })
    expect(await service.consumeRealtimeTicket(issued.ticket)).toBeNull()
    const revokedTicket = await service.issueRealtimeTicket(app.rawSession)
    await repository.revokeSession(app.session.id, 'test_revocation', new Date())
    expect(await service.consumeRealtimeTicket(revokedTicket.ticket)).toBeNull()
    expect(transient.tickets).toHaveLength(0)
  })

  it('fails closed when a normal SSO user tries to establish an admin session', async () => {
    const { service } = fixture()
    const authorizeUrl = await service.startLogin('admin', '/')
    const fields = oauthFields(authorizeUrl)
    const authenticated = await service.authenticate('user@example.test', 'correct-password', false)
    await expect(service.issueAuthorizationCode({
      clientId: fields.client_id!, redirectUri: fields.redirect_uri!, responseType: fields.response_type!,
      scope: fields.scope!, state: fields.state!, nonce: fields.nonce!, codeChallenge: fields.code_challenge!,
      codeChallengeMethod: fields.code_challenge_method!,
    }, authenticated.rawSession)).rejects.toMatchObject({ code: 'auth_admin_required', status: 403 })
  })

  it('revokes web and Bridge credentials only for the explicit all-devices scope', async () => {
    const { service, bridge } = fixture()
    const authenticated = await service.authenticate('user@example.test', 'correct-password', false)
    await service.revokeAll(authenticated.session)
    expect(bridge.revokedUsers).toEqual([7])
    await expect(service.resolveSession(authenticated.rawSession, 'auth')).rejects.toBeInstanceOf(AuthError)
  })
})

describe('SSO V4 HTTP routes', () => {
  it.each([true, false])('validates identity center session and logout contracts (secure=%s)', async secureCookies => {
    const { service, bridge } = fixture()
    const contract = JSON.parse(await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ strict: false })
    const addFormats = createRequire(import.meta.url)('ajv-formats')
    addFormats(ajv)
    const validate = ajv.compile({ ...contract.components.schemas.AuthCenterSessionResponse, components: contract.components })
    const validateProblem = ajv.compile({ ...contract.components.schemas.Problem, components: contract.components })
    const { rawSession } = await service.authenticate('user@example.test', 'correct-password', false)
    const other = await service.authenticate('user@example.test', 'correct-password', false)
    const cookieName = secureCookies ? '__Host-Http-auth_session' : 'aurum_dev_auth_session'
    const headers = { host: 'auth.example.test', cookie: `${cookieName}=${rawSession}` }
    const auth = Fastify()
    try {
      await auth.register(authCenterRoutes, { service, secureCookies })
      const session = await auth.inject({ url: '/api/v4/auth/session', headers })
      expect(session.statusCode).toBe(200)
      expect(session.headers['cache-control']).toBe('no-store')
      const body = session.json()
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true)
      expect(body.data.user.id).toBe('7')
      expect(validate({ ...body, data: { ...body.data, app: 'trade', permissions: [] } })).toBe(false)
      expect(validate({ ...body, data: { ...body.data, authenticated_at: 'not-a-date' } })).toBe(false)
      const failures = [
        await auth.inject({ url: '/api/v4/auth/session', headers: { host: headers.host } }),
        await auth.inject({ url: '/api/v4/auth/session', headers: { ...headers, cookie: `__Host-Http-trade_session=${rawSession}` } }),
        await auth.inject({ url: '/api/v4/auth/session', headers: { ...headers, host: 'trade.example.test' } }),
        await auth.inject({ method: 'POST', url: '/api/v4/auth/logout', headers }),
        await auth.inject({ method: 'POST', url: '/api/v4/auth/logout', headers: { ...headers, origin: 'https://evil.example.test', 'x-csrf-token': body.data.csrf_token } }),
      ]
      expect(failures.map(response => response.statusCode)).toEqual([401, 401, 404, 403, 403])
      for (const response of failures) {
        expect(response.headers['content-type']).toContain('application/json')
        expect(validateProblem(response.json()), JSON.stringify(validateProblem.errors)).toBe(true)
      }
      await expect(service.resolveSession(rawSession, 'auth')).resolves.toBeDefined()
      const logoutHeaders = { ...headers, origin: 'https://auth.example.test', 'x-csrf-token': body.data.csrf_token }
      const logout = await auth.inject({ method: 'POST', url: '/api/v4/auth/logout', headers: logoutHeaders })
      expect(logout.statusCode).toBe(204)
      expect(logout.body).toBe('')
      expect(logout.headers['set-cookie']).toContain(`${cookieName}=`)
      expect(logout.headers['set-cookie']).toContain('Max-Age=0')
      expect(logout.headers['set-cookie']).not.toContain('Domain=')
      expect((await auth.inject({ url: '/api/v4/auth/session', headers })).statusCode).toBe(401)
      expect((await auth.inject({ method: 'POST', url: '/api/v4/auth/logout', headers: logoutHeaders })).statusCode).toBe(401)
      await expect(service.resolveSession(other.rawSession, 'auth')).resolves.toBeDefined()
      expect(bridge.revokedUsers).toEqual([])
    } finally {
      await auth.close()
    }
  })

  it.each([true, false])('unlocks www courses with the matching cookie policy (secure=%s)', async secureCookies => {
    const { service } = fixture()
    const www = Fastify(), auth = Fastify()
    const learning = new LearningService({
      list: async () => [],
      course: async () => ({ id: '12', title: '课程', description: null, category: null, access_level: 'logged_in', updated_at: null, sort_order: 0 }),
      lessons: async (_id, userId) => {
        expect(userId).toBe(7)
        return [{ id: '99', title: '课时', duration_ms: null, resources: [], progress: { watched_ms: '10000', reported_duration_ms: null, completed: false, updated_at: null, revision: '1' } }]
      },
    }, { activePlan: async () => 'free' })
    try {
      await www.register(appSessionRoutes, { service, surface: 'www', secureCookies })
      await www.register(learningRoutes, { prefix: '/api/v4', service: learning, auth: service, wwwOrigin: 'https://www.example.test', secureCookies })
      let savedCount = 0
      await www.register(learningCompletionRoutes, { prefix: '/api/v4', auth: service, wwwOrigin: 'https://www.example.test', secureCookies,
        service: new LearningCompletionService({ execute: async command => {
          savedCount++
          expect(command.userId).toBe(7)
          return { lesson_id: command.lessonId, completed: command.completed, revision: '2', updated_at: '2026-09-07T01:00:00.123Z', replayed: false }
        } }) })
      await auth.register(authCenterRoutes, { service, secureCookies })
      const detail = (cookie?: string) => www.inject({ url: '/api/v4/learning/courses/12', headers: { host: 'www.example.test', ...(cookie ? { cookie } : {}) } })
      expect((await detail()).json().data.access).toBe('login_required')
      const start = await www.inject({ url: '/auth/start?next=%2Fcourses%2F12' })
      const login = await auth.inject({ method: 'POST', url: '/api/v4/auth/login', headers: { host: 'auth.example.test', origin: 'https://auth.example.test' }, payload: {
        ...oauthFields(start.headers.location!), login: 'user@example.test', password: 'correct-password',
      } })
      expect(login.statusCode).toBe(200)
      const redirect = new URL(login.json().data.redirect_to)
      const callback = await www.inject({ url: redirect.pathname + redirect.search })
      expect(callback.statusCode).toBe(302)
      expect(callback.headers.location).toBe('/courses/12')
      const cookie = String(callback.headers['set-cookie']).split(';')[0]!
      expect(cookie).toMatch(secureCookies ? /^__Host-Http-www_session=/ : /^aurum_dev_www-web_session=/)
      expect(callback.headers['set-cookie']).not.toContain('Domain=')
      const mismatchedCookie = cookie.replace(/^[^=]+=/, secureCookies ? 'aurum_dev_www-web_session=' : '__Host-Http-www_session=')
      expect((await detail(mismatchedCookie)).json().data.access).toBe('login_required')
      const session = await www.inject({ url: '/api/v4/session', headers: { cookie } })
      expect(session.json().data.app).toBe('www')
      const opened = await detail(cookie)
      expect(opened.json().data.access).toBe('allowed')
      expect(opened.json().data.lessons[0].progress.watched_ms).toBe('10000')
      const csrf = session.json().data.csrf_token as string
      const write = (extra: Record<string, string> = {}, payload: Record<string, unknown> = { completed: true, expected_revision: '1' }) => www.inject({
        method: 'PUT', url: '/api/v4/learning/courses/12/lessons/99/completion', headers: { host: 'www.example.test', cookie,
          origin: 'https://www.example.test', 'x-csrf-token': csrf, 'idempotency-key': 'a56a2134-9105-4e93-a806-bb3793f7ad38', ...extra }, payload,
      })
      expect((await write({ 'x-csrf-token': '' })).statusCode).toBe(403)
      expect((await write({ origin: 'https://evil.example.test' })).statusCode).toBe(403)
      expect((await write({ host: 'trade.example.test' })).statusCode).toBe(421)
      expect((await write({}, { completed: true, expected_revision: '1', user_id: 9 })).statusCode).toBe(400)
      expect((await write()).json().data).toMatchObject({ completed: true, revision: '2' })
      expect(savedCount).toBe(1)
      expect((await www.inject({ method: 'POST', url: '/api/v4/session/logout', headers: { cookie, origin: 'https://evil.example.test', 'x-csrf-token': csrf } })).statusCode).toBe(403)
      expect((await www.inject({ method: 'POST', url: '/api/v4/session/logout', headers: { cookie, origin: 'https://www.example.test', 'x-csrf-token': csrf } })).statusCode).toBe(204)
      expect((await detail(cookie)).statusCode).toBe(401)
      expect((await write()).statusCode).toBe(401)
      expect(savedCount).toBe(1)
    } finally { await www.close(); await auth.close() }
  })

  it('runs login, callback, session, CSRF, realtime and logout through Host-only cookies', async () => {
    const { service } = fixture()
    const trade = Fastify({ logger: false })
    const auth = Fastify({ logger: false })
    await trade.register(appSessionRoutes, { service, surface: 'trade', secureCookies: true })
    await auth.register(authCenterRoutes, { service, secureCookies: true })

    const start = await trade.inject({ method: 'GET', url: '/auth/start?next=%2Fanalyst' })
    expect(start.statusCode).toBe(302)
    const fields = oauthFields(start.headers.location!)

    const authorize = await auth.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(fields)}`, headers: { host: 'auth.example.test' } })
    expect(authorize.statusCode).toBe(302)
    expect(authorize.headers.location?.startsWith('/login?')).toBe(true)

    const login = await auth.inject({ method: 'POST', url: '/api/v4/auth/login', headers: { host: 'auth.example.test', origin: 'https://auth.example.test' }, payload: {
      ...fields, login: 'user@example.test', password: 'correct-password', remember: true,
    } })
    expect(login.statusCode).toBe(200)
    expect(login.headers['set-cookie']).toContain('__Host-Http-auth_session=')
    expect(login.headers['set-cookie']).toContain('Secure; Max-Age=2592000')
    const redirect = new URL(login.json().data.redirect_to)

    const callback = await trade.inject({ method: 'GET', url: `${redirect.pathname}${redirect.search}` })
    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/analyst')
    const appCookie = String(callback.headers['set-cookie']).split(';')[0]!
    expect(callback.headers['set-cookie']).toContain('__Host-Http-trade_session=')
    expect(callback.headers['set-cookie']).not.toContain('__Host-Http-auth_session')

    const session = await trade.inject({ method: 'GET', url: '/api/v4/session', headers: { cookie: appCookie } })
    expect(session.statusCode).toBe(200)
    expect(session.json().data).toMatchObject({ app: 'trade', user: { id: '7', display_name: '测试交易者' } })
    const csrf = session.json().data.csrf_token as string

    const badOrigin = await trade.inject({ method: 'POST', url: '/api/v4/realtime/tickets', headers: {
      cookie: appCookie, origin: 'https://evil.example.test', 'x-csrf-token': csrf,
    } })
    expect(badOrigin.statusCode).toBe(403)

    const ticket = await trade.inject({ method: 'POST', url: '/api/v4/realtime/tickets', headers: {
      cookie: appCookie, origin: 'https://trade.example.test', 'x-csrf-token': csrf,
    } })
    expect(ticket.statusCode).toBe(201)
    expect(ticket.headers['set-cookie']).toContain('Path=/realtime/v4')
    expect(ticket.json().data).not.toHaveProperty('token')

    const logout = await trade.inject({ method: 'POST', url: '/api/v4/session/logout', headers: {
      cookie: appCookie, origin: 'https://trade.example.test', 'x-csrf-token': csrf,
    } })
    expect(logout.statusCode).toBe(204)
    expect(logout.headers['set-cookie']).toContain('Max-Age=0')
    await trade.close()
    await auth.close()
  })

  it('resolves the application boundary from the exact request host in one Fastify process', async () => {
    const { service } = fixture()
    const app = Fastify({ logger: false })
    await registerSsoRoutes(app, service, false)

    const tradeStart = await app.inject({ method: 'GET', url: '/auth/start', headers: { host: 'trade.example.test' } })
    expect(tradeStart.statusCode).toBe(302)
    expect(new URL(tradeStart.headers.location!).searchParams.get('client_id')).toBe('trade-web')

    const fields = oauthFields(tradeStart.headers.location!)
    const login = await app.inject({ method: 'POST', url: '/api/v4/auth/login', headers: {
      host: 'auth.example.test', origin: 'https://auth.example.test',
    }, payload: { ...fields, login: 'user@example.test', password: 'correct-password' } })
    expect(login.statusCode).toBe(200)
    expect(login.headers['set-cookie']).toContain('aurum_dev_auth_session=')
    expect(login.headers['set-cookie']).not.toContain('Secure')

    const redirect = new URL(login.json().data.redirect_to)
    const callback = await app.inject({ method: 'GET', url: `${redirect.pathname}${redirect.search}`, headers: {
      host: 'trade.example.test',
    } })
    expect(callback.statusCode).toBe(302)
    expect(callback.headers['set-cookie']).toContain('aurum_dev_trade-web_session=')
    expect(callback.headers['set-cookie']).not.toContain('__Host-')

    const unknownStart = await app.inject({ method: 'GET', url: '/auth/start', headers: { host: 'unknown.example.test' } })
    expect(unknownStart.statusCode).toBe(400)
    expect(unknownStart.json().code).toBe('auth_surface_invalid')
    await app.close()
  })
})

describe('migration contract', () => {
  it('never stores browser secrets in plaintext columns', async () => {
    expect(hashSecret('opaque')).toMatch(/^[0-9a-f]{64}$/)
    const migration = await readFile(new URL('../db/migrations/20260903_002_auth_sso_sessions.sql', import.meta.url), 'utf8')
    expect(migration.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2)
    expect(migration).toContain('session_hash CHAR(64)')
    expect(migration).toContain('code_hash CHAR(64)')
    expect(migration).toContain('auth_time_utc DATETIME(3)')
    expect(migration).not.toMatch(/password\s+(?:VAR)?CHAR/i)
    expect(migration).not.toContain('code_verifier')
  })

  it('signs short-lived OIDC identity claims with an ES256 key published through JWKS', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const signer = new Es256IdTokenSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 'auth-key-1')
    const token = await signer.sign({
      issuer: 'https://auth.example.test', audience: 'trade-web', subject: '7', nonce: 'nonce',
      authTimeSeconds: 1, issuedAtSeconds: 2, expiresAtSeconds: 62, mfaLevel: 'none',
    })
    const [header, payload, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({ alg: 'ES256', kid: 'auth-key-1' })
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ aud: 'trade-web', sub: '7', exp: 62 })
    const publicKey = signer.jwks().keys[0]!
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), {
      key: { ...publicKey, key_ops: ['verify'], ext: true }, format: 'jwk', dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature!, 'base64url'))).toBe(true)
  })
})
