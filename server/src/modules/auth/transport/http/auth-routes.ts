import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthService, AuthorizationRequest } from '../../application/auth-service.js'
import type { AppSurface } from '../../domain/auth.js'
import { AuthError, transportSessionCookieName } from '../../domain/auth.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

interface AuthCenterOptions {
  service: AuthService
  secureCookies?: boolean
}

interface AppSessionOptions extends AuthCenterOptions {
  surface?: AppSurface
}

function cookieMap(header: string | undefined) {
  const result = new Map<string, string>()
  for (const item of String(header ?? '').split(';')) {
    const index = item.indexOf('=')
    if (index <= 0) continue
    result.set(item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim()))
  }
  return result
}

function sessionCookie(name: string, value: string, secure: boolean, maxAge?: number) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (secure) attributes.push('Secure')
  if (maxAge !== undefined) attributes.push(`Max-Age=${maxAge}`)
  return attributes.join('; ')
}

function sessionCookieName(service: AuthService, clientId: string, secure: boolean) {
  return transportSessionCookieName(clientId, secure, service.cookieName(clientId))
}

function realtimeCookie(value: string, secure: boolean) {
  const name = secure ? '__Secure-Http-realtime_ticket' : 'aurum_dev_realtime_ticket'
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/realtime/v4', 'HttpOnly', 'SameSite=Strict', 'Max-Age=30']
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

function authorizationRequest(input: Record<string, unknown>): AuthorizationRequest {
  return {
    clientId: String(input.client_id ?? ''),
    redirectUri: String(input.redirect_uri ?? ''),
    responseType: String(input.response_type ?? ''),
    scope: String(input.scope ?? ''),
    state: String(input.state ?? ''),
    nonce: String(input.nonce ?? ''),
    codeChallenge: String(input.code_challenge ?? ''),
    codeChallengeMethod: String(input.code_challenge_method ?? ''),
  }
}

function readSession(request: FastifyRequest, name: string) {
  return cookieMap(request.headers.cookie).get(name)
}

function meta(request: FastifyRequest) {
  return { request_id: request.id, generated_at: new Date().toISOString() }
}

function sendProblem(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const known = error instanceof AuthError ? error : new AuthError('auth_service_unavailable', 503, true)
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`,
    title: 'Authentication request failed',
    status: known.status,
    code: known.code,
    detail: known.code,
    instance: request.url,
    correlation_id: request.id,
    retryable: known.retryable,
  })
}

function redirectToLogin(request: FastifyRequest, reply: FastifyReply) {
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : ''
  return reply.redirect(`/login${query ? `?${query}` : ''}`)
}

function validateSessionRequest(contract: ReturnType<typeof createHttpContractValidator>, operation: string, request: FastifyRequest) {
  if (Object.keys(request.query ?? {}).length) throw new HttpContractError('api_request_invalid', 400)
  contract.request(operation, request)
}

function sessionProblem(error: unknown, request: FastifyRequest, reply: FastifyReply, contract: ReturnType<typeof createHttpContractValidator>, operation: string) {
  const known = error instanceof AuthError || error instanceof HttpContractError ? error : new AuthError('auth_service_unavailable', 503, true)
  const body = { type: `urn:aurum:problem:${known.code}`, title: 'Authentication request failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url, correlation_id: request.id,
    retryable: known instanceof AuthError ? known.retryable : known.status >= 500 }
  return reply.header('Cache-Control', 'no-store').type('application/problem+json').code(known.status)
    .send(contract.response(operation, body, known.status, 'application/problem+json'))
}

function assertAuthHost(request: FastifyRequest, service: AuthService) {
  if (String(request.headers.host ?? '').toLowerCase() !== new URL(service.issuer).host.toLowerCase()) {
    throw new AuthError('auth_host_invalid', 404)
  }
}

export const authCenterRoutes: FastifyPluginAsync<AuthCenterOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getAuthCenterSession', 'logoutAuthCenterSession', 'loginAtIdentityCenter'])
  const secure = options.secureCookies ?? true
  const authCookieName = sessionCookieName(options.service, 'auth', secure)

  fastify.get('/.well-known/openid-configuration', async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      return {
        issuer: options.service.issuer,
        authorization_endpoint: `${options.service.issuer}/oauth/authorize`,
        token_endpoint: `${options.service.issuer}/oauth/token`,
        jwks_uri: `${options.service.issuer}/oauth/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        scopes_supported: ['openid', 'profile'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
      }
    } catch (error) { return sendProblem(error, request, reply) }
  })

  fastify.get('/oauth/jwks', async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      return options.service.jwks()
    } catch (error) { return sendProblem(error, request, reply) }
  })

  fastify.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      const authRequest = authorizationRequest(request.query)
      options.service.validateAuthorizationRequest(authRequest)
      const rawSession = readSession(request, authCookieName)
      if (!rawSession) return redirectToLogin(request, reply)
      return reply.redirect(await options.service.issueAuthorizationCode(authRequest, rawSession))
    } catch (error) {
      return sendProblem(error, request, reply)
    }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/api/v4/auth/login', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      if (request.headers.origin !== new URL(options.service.issuer).origin) throw new AuthError('auth_origin_invalid', 403)
      validateSessionRequest(contract, 'loginAtIdentityCenter', request)
      const body = request.body
      const result = await options.service.finishLogin(
        authorizationRequest(body),
        String(body.login ?? ''),
        String(body.password ?? ''),
        body.remember === true,
      )
      const bodyResult = contract.response('loginAtIdentityCenter', { data: { redirect_to: result.redirectTo }, meta: meta(request) })
      const redirect = new URL(result.redirectTo)
      const expectedRedirect = new URL(String(body.redirect_uri))
      if (!/^as_[A-Za-z0-9_-]{43}$/.test(result.rawSession) || redirect.origin !== expectedRedirect.origin
        || redirect.pathname !== expectedRedirect.pathname) throw new AuthError('auth_login_result_invalid', 503)
      reply.header('Cache-Control', 'no-store')
      reply.header('Set-Cookie', sessionCookie(authCookieName, result.rawSession, secure, result.remember ? 30 * 24 * 60 * 60 : undefined))
      return reply.code(200).send(bodyResult)
    } catch (error) {
      return sessionProblem(error, request, reply, contract, 'loginAtIdentityCenter')
    }
  })

  fastify.post<{ Body: Record<string, unknown> }>('/oauth/token', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      if (request.headers['x-aurum-bff-exchange-key'] !== options.service.bffExchangeSecret) {
        throw new AuthError('auth_bff_required', 401)
      }
      const body = request.body
      const result = await options.service.exchangeCode({
        code: String(body.code ?? ''),
        state: String(body.state ?? ''),
        codeVerifier: String(body.code_verifier ?? ''),
        clientId: String(body.client_id ?? ''),
        redirectUri: String(body.redirect_uri ?? ''),
      })
      reply.header('Cache-Control', 'no-store')
      return reply.code(200).send({
        token_type: 'Bearer',
        expires_in: 60,
        id_token: result.idToken,
        application_session: result.rawSession,
        application_session_cookie_name: sessionCookieName(options.service, result.client.clientId, secure),
        next: result.next,
      })
    } catch (error) {
      return sendProblem(error, request, reply)
    }
  })

  fastify.post('/api/v4/auth/logout', async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      const rawSession = readSession(request, authCookieName)
      if (!rawSession) throw new AuthError('auth_session_required', 401)
      const { session } = await options.service.resolveSession(rawSession, 'auth')
      options.service.assertAuthCsrf(rawSession, session, String(request.headers['x-csrf-token'] ?? ''), request.headers.origin)
      validateSessionRequest(contract, 'logoutAuthCenterSession', request)
      if (request.body !== undefined) throw new HttpContractError('api_request_invalid', 400)
      contract.response('logoutAuthCenterSession', undefined, 204)
      await options.service.logoutCurrent(session)
      reply.header('Cache-Control', 'no-store')
      reply.header('Set-Cookie', sessionCookie(authCookieName, '', secure, 0))
      return reply.code(204).send()
    } catch (error) {
      return sessionProblem(error, request, reply, contract, 'logoutAuthCenterSession')
    }
  })

  fastify.get('/api/v4/auth/session', async (request, reply) => {
    try {
      assertAuthHost(request, options.service)
      const rawSession = readSession(request, authCookieName)
      if (!rawSession) throw new AuthError('auth_session_required', 401)
      const { session, user } = await options.service.resolveSession(rawSession, 'auth')
      validateSessionRequest(contract, 'getAuthCenterSession', request)
      reply.header('Cache-Control', 'no-store')
      return reply.send(contract.response('getAuthCenterSession', {
        data: {
          user: { id: String(user.id), display_name: user.displayName, avatar_url: user.avatarUrl },
          authenticated_at: session.authTimeUtc.toISOString(),
          mfa_level: session.mfaLevel,
          csrf_token: options.service.csrfToken(rawSession, session),
        },
        meta: meta(request),
      }))
    } catch (error) { return sessionProblem(error, request, reply, contract, 'getAuthCenterSession') }
  })
}

export const appSessionRoutes: FastifyPluginAsync<AppSessionOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getApplicationSession', 'logoutCurrentApplication', 'logoutAllWebApplications', 'revokeAllSessionsAndDevices', 'createRealtimeTicket'])
  const secure = options.secureCookies ?? true
  const fixedClient = options.surface ? options.service.clientForSurface(options.surface) : null
  const clientFor = (request: FastifyRequest) => fixedClient ?? options.service.clientForHost(request.headers.host)
  const cookieNameFor = (clientId: string) => sessionCookieName(options.service, clientId, secure)

  fastify.get<{ Querystring: { next?: string } }>('/auth/start', async (request, reply) => {
    try {
      return reply.redirect(await options.service.startLogin(clientFor(request).surface, request.query.next))
    } catch (error) {
      return sendProblem(error, request, reply)
    }
  })

  fastify.get<{ Querystring: { code?: string; state?: string } }>('/auth/callback', async (request, reply) => {
    try {
      const client = clientFor(request)
      const state = String(request.query.state ?? '')
      const transaction = await options.service.exchangeCode({
        code: String(request.query.code ?? ''),
        state,
        clientId: client.clientId,
        redirectUri: client.redirectUri,
      })
      reply.header('Set-Cookie', sessionCookie(cookieNameFor(client.clientId), transaction.rawSession, secure, client.sessionAbsoluteSeconds))
      return reply.redirect(transaction.next)
    } catch (error) {
      return sendProblem(error, request, reply)
    }
  })

  fastify.get('/api/v4/session', async (request, reply) => {
    try {
      const client = clientFor(request)
      const rawSession = readSession(request, cookieNameFor(client.clientId))
      if (!rawSession) throw new AuthError('auth_session_required', 401)
      const summary = await options.service.sessionSummary(rawSession, client.clientId)
      validateSessionRequest(contract, 'getApplicationSession', request)
      reply.header('Cache-Control', 'no-store')
      return reply.send(contract.response('getApplicationSession', { data: summary.data, meta: meta(request) }))
    } catch (error) {
      return sessionProblem(error, request, reply, contract, 'getApplicationSession')
    }
  })

  async function authorizedWrite(request: FastifyRequest) {
    const client = clientFor(request)
    const rawSession = readSession(request, cookieNameFor(client.clientId))
    if (!rawSession) throw new AuthError('auth_session_required', 401)
    const resolved = await options.service.resolveSession(rawSession, client.clientId)
    options.service.assertCsrf(rawSession, resolved.session, String(request.headers['x-csrf-token'] ?? ''), request.headers.origin)
    return { rawSession, client, ...resolved }
  }

  fastify.post('/api/v4/session/logout', async (request, reply) => {
    try {
      const { client, session } = await authorizedWrite(request)
      validateSessionRequest(contract, 'logoutCurrentApplication', request)
      if (request.body !== undefined) throw new HttpContractError('api_request_invalid', 400)
      contract.response('logoutCurrentApplication', undefined, 204)
      await options.service.logoutCurrent(session)
      reply.header('Cache-Control', 'no-store')
      reply.header('Set-Cookie', sessionCookie(cookieNameFor(client.clientId), '', secure, 0))
      return reply.code(204).send()
    } catch (error) { return sessionProblem(error, request, reply, contract, 'logoutCurrentApplication') }
  })

  fastify.post('/api/v4/session/logout-web', async (request, reply) => {
    try {
      const { client, user } = await authorizedWrite(request)
      validateSessionRequest(contract, 'logoutAllWebApplications', request)
      if (request.body !== undefined) throw new HttpContractError('api_request_invalid', 400)
      contract.response('logoutAllWebApplications', undefined, 204)
      await options.service.logoutWeb(user.id)
      reply.header('Cache-Control', 'no-store')
      reply.header('Set-Cookie', sessionCookie(cookieNameFor(client.clientId), '', secure, 0))
      return reply.code(204).send()
    } catch (error) { return sessionProblem(error, request, reply, contract, 'logoutAllWebApplications') }
  })

  fastify.post('/api/v4/session/revoke-all', async (request, reply) => {
    try {
      const { client, session } = await authorizedWrite(request)
      validateSessionRequest(contract, 'revokeAllSessionsAndDevices', request)
      if (request.body !== undefined) throw new HttpContractError('api_request_invalid', 400)
      contract.response('revokeAllSessionsAndDevices', undefined, 204)
      await options.service.revokeAll(session)
      reply.header('Cache-Control', 'no-store')
      reply.header('Set-Cookie', sessionCookie(cookieNameFor(client.clientId), '', secure, 0))
      return reply.code(204).send()
    } catch (error) { return sessionProblem(error, request, reply, contract, 'revokeAllSessionsAndDevices') }
  })

  fastify.post('/api/v4/realtime/tickets', async (request, reply) => {
      try {
        const { rawSession, client, session } = await authorizedWrite(request)
        if (client.surface !== 'trade') throw new AuthError('auth_trade_session_required', 403)
        validateSessionRequest(contract, 'createRealtimeTicket', request)
        if (request.body !== undefined) throw new HttpContractError('api_request_invalid', 400)
        const issued = await options.service.issueRealtimeTicket(rawSession)
        if (issued.session.id !== session.id) throw new AuthError('auth_session_invalid', 401)
        if (!/^rt_[A-Za-z0-9_-]{43}$/.test(issued.ticket)) throw new AuthError('auth_ticket_result_invalid', 503)
        const result = contract.response('createRealtimeTicket', {
          data: {
            ws_url: '/realtime/v4',
            protocol: 'aurum.realtime.v4',
            capabilities: ['market.read', 'account.read'],
            expires_at: issued.expiresAt.toISOString(),
          },
          meta: meta(request),
        }, 201)
        reply.header('Cache-Control', 'no-store')
        reply.header('Set-Cookie', realtimeCookie(issued.ticket, secure))
        return reply.code(201).send(result)
      } catch (error) { return sessionProblem(error, request, reply, contract, 'createRealtimeTicket') }
  })
}
