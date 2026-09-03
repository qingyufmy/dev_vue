import type { FastifyError, FastifyPluginAsync } from 'fastify'
import { BridgeCredentialError } from '../../domain/bridge-credential.js'
import type { BridgeCredentialService } from '../../application/bridge-credential-service.js'

interface LegacyExchangeBody {
  schema_version: number
  legacy_refresh_token: string
  installation_id: string
  profile_id: string
  source_fingerprint: string
}

interface SessionTokenBody {
  refresh_token: string
  installation_id: string
  profile_id: string
}

export interface BridgeCredentialRoutesOptions {
  service: BridgeCredentialService
}

const deviceIdSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }
const refreshTokenSchema = { type: 'string', minLength: 40, maxLength: 512, pattern: '^\\S+$' }
const metaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['request_id', 'generated_at'],
  properties: {
    request_id: { type: 'string', minLength: 1, maxLength: 191 },
    generated_at: { type: 'string', format: 'date-time' },
  },
}
const problemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'code', 'detail', 'instance', 'correlation_id', 'retryable'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    code: { type: 'string' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    correlation_id: { type: 'string' },
    retryable: { type: 'boolean' },
  },
}
const refreshCredentialResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'meta'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['credential_type', 'refresh_token', 'generation', 'session_token_path', 'websocket_path'],
      properties: {
        credential_type: { const: 'bridge_refresh' },
        refresh_token: refreshTokenSchema,
        generation: { type: 'integer', minimum: 1 },
        session_token_path: { const: '/api/v4/bridge/session-tokens' },
        websocket_path: { const: '/bridge/v4/ws' },
      },
    },
    meta: metaSchema,
  },
}
const sessionTokenResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data', 'meta'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['credential_type', 'access_token', 'expires_in_seconds', 'websocket_path'],
      properties: {
        credential_type: { const: 'bridge_session' },
        access_token: { type: 'string', minLength: 40, maxLength: 128 },
        expires_in_seconds: { type: 'integer', minimum: 1, maximum: 60 },
        websocket_path: { const: '/bridge/v4/ws' },
      },
    },
    meta: metaSchema,
  },
}

function meta(requestId: string) {
  return { request_id: requestId, generated_at: new Date().toISOString() }
}

function sendProblem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof BridgeCredentialError
    ? error
    : new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
  return reply.code(known.status).send({
    type: `urn:aurum:problem:${known.code}`,
    title: 'Bridge credential request failed',
    status: known.status,
    code: known.code,
    detail: known.code,
    instance: request.url,
    correlation_id: request.id,
    retryable: known.retryable,
  })
}

export const bridgeCredentialRoutes: FastifyPluginAsync<BridgeCredentialRoutesOptions> = async (fastify, options) => {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
      || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
      || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return sendProblem(
        new BridgeCredentialError('bridge_credential_request_invalid', 400),
        request,
        reply,
      )
    }
    return sendProblem(error, request, reply)
  })

  fastify.post<{ Body: LegacyExchangeBody }>('/bridge/legacy-credential-exchanges', {
    bodyLimit: 8 * 1024,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['schema_version', 'legacy_refresh_token', 'installation_id', 'profile_id', 'source_fingerprint'],
        properties: {
          schema_version: { const: 1 },
          legacy_refresh_token: refreshTokenSchema,
          installation_id: deviceIdSchema,
          profile_id: deviceIdSchema,
          source_fingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
        },
      },
      response: {
        200: refreshCredentialResponseSchema,
        400: problemSchema,
        401: problemSchema,
        409: problemSchema,
        429: problemSchema,
        503: problemSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const data = await options.service.exchangeLegacyCredential({
        schemaVersion: request.body.schema_version,
        legacyRefreshToken: request.body.legacy_refresh_token,
        installationId: request.body.installation_id,
        profileId: request.body.profile_id,
        sourceFingerprint: request.body.source_fingerprint,
        userAgent: String(request.headers['user-agent'] ?? ''),
        ipAddress: request.ip,
      })
      return reply.code(200).send({ data, meta: meta(request.id) })
    } catch (error) {
      return sendProblem(error, request, reply)
    }
  })

  fastify.post<{ Body: SessionTokenBody }>('/bridge/session-tokens', {
    bodyLimit: 4 * 1024,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['refresh_token', 'installation_id', 'profile_id'],
        properties: {
          refresh_token: refreshTokenSchema,
          installation_id: deviceIdSchema,
          profile_id: deviceIdSchema,
        },
      },
      response: {
        201: sessionTokenResponseSchema,
        400: problemSchema,
        401: problemSchema,
        429: problemSchema,
        503: problemSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const data = await options.service.createSessionToken({
        refreshToken: request.body.refresh_token,
        installationId: request.body.installation_id,
        profileId: request.body.profile_id,
        userAgent: String(request.headers['user-agent'] ?? ''),
        ipAddress: request.ip,
      })
      return reply.code(201).send({ data, meta: meta(request.id) })
    } catch (error) {
      return sendProblem(error, request, reply)
    }
  })
}
