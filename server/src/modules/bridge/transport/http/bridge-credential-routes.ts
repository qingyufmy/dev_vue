import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { FastifyError, FastifyPluginAsync, FastifyRequest } from 'fastify'
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

const operationPaths = {
  '/bridge/credential-revocations': 'revokeBridgeDeviceCredential',
  '/bridge/legacy-credential-exchanges': 'exchangeLegacyBridgeCredential',
  '/bridge/session-tokens': 'createBridgeSessionToken',
} as const

function meta(requestId: string) { return { request_id: requestId, generated_at: new Date().toISOString() } }

export const bridgeCredentialRoutes: FastifyPluginAsync<BridgeCredentialRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, Object.values(operationPaths))
  const validate = (operation: string, request: FastifyRequest) => {
    if (Object.keys(request.query ?? {}).length) throw new BridgeCredentialError('bridge_credential_request_invalid', 400)
    contract.request(operation, request)
  }
  const result = (operation: string, data: unknown, requestId: string, status: number) => {
    try { return contract.response(operation, { data, meta: meta(requestId) }, status) }
    catch { throw new BridgeCredentialError('bridge_credential_result_unknown', 503, false) }
  }
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store')
    return payload
  })
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const invalid = error.validation || ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_BODY_TOO_LARGE', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(error.code ?? '')
      || error instanceof HttpContractError && error.status === 400
    const known = invalid ? new BridgeCredentialError('bridge_credential_request_invalid', 400)
      : error instanceof BridgeCredentialError ? error : new BridgeCredentialError('bridge_credential_storage_failed', 503, true)
    const operation = Object.entries(operationPaths).find(([path]) => request.routeOptions.url?.endsWith(path))?.[1]
    const body = { type: `urn:aurum:problem:${known.code}`, title: 'Bridge credential request failed', status: known.status,
      code: known.code, detail: known.code, instance: request.url.split('?')[0], correlation_id: request.id, retryable: known.retryable }
    if (!operation) return reply.type('application/problem+json').code(known.status).send(body)
    return reply.type('application/problem+json').code(known.status).send(contract.response(operation, body, known.status, 'application/problem+json'))
  })

  fastify.post<{ Body: SessionTokenBody }>('/bridge/credential-revocations', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    validate('revokeBridgeDeviceCredential', request)
    const data = await options.service.revokeDeviceCredential({ refreshToken: request.body.refresh_token,
      installationId: request.body.installation_id, profileId: request.body.profile_id })
    return reply.code(200).send(result('revokeBridgeDeviceCredential', data, request.id, 200))
  })

  fastify.post<{ Body: LegacyExchangeBody }>('/bridge/legacy-credential-exchanges', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    validate('exchangeLegacyBridgeCredential', request)
    const data = await options.service.exchangeLegacyCredential({ schemaVersion: request.body.schema_version,
      legacyRefreshToken: request.body.legacy_refresh_token, installationId: request.body.installation_id,
      profileId: request.body.profile_id, sourceFingerprint: request.body.source_fingerprint,
      userAgent: String(request.headers['user-agent'] ?? ''), ipAddress: request.ip })
    return reply.code(200).send(result('exchangeLegacyBridgeCredential', data, request.id, 200))
  })

  fastify.post<{ Body: SessionTokenBody }>('/bridge/session-tokens', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    validate('createBridgeSessionToken', request)
    const data = await options.service.createSessionToken({ refreshToken: request.body.refresh_token,
      installationId: request.body.installation_id, profileId: request.body.profile_id,
      userAgent: String(request.headers['user-agent'] ?? ''), ipAddress: request.ip })
    return reply.code(201).send(result('createBridgeSessionToken', data, request.id, 201))
  })
}
