import type { FastifyError, FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { BridgePairingError, type BridgePairingService } from '../../application/bridge-pairing-service.js'

export interface BridgePairingRoutesOptions {
  service: BridgePairingService
  auth: { assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }> }
}

export const bridgePairingRoutes: FastifyPluginAsync<BridgePairingRoutesOptions> = async (app, options) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const known = error instanceof AuthError || error instanceof BridgePairingError
    const invalid = error.validation || ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_BODY_TOO_LARGE', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(error.code ?? '')
    const status = invalid ? 400 : known ? error.status : 503
    const code = invalid ? 'bridge_pairing_request_invalid' : known ? error.code : 'bridge_pairing_storage_failed'
    return reply.code(status).send({ type: `urn:aurum:problem:${code}`, title: 'Bridge pairing request failed',
      status, code, detail: code, instance: request.url, correlation_id: request.id, retryable: status === 503 })
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store')
    return payload
  })
  app.post<{ Body: { code_hash: string } }>('/bridge/pairing-requests', {
    bodyLimit: 1024,
    schema: { body: { type: 'object', additionalProperties: false, required: ['code_hash'],
      properties: { code_hash: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' } } } },
  }, async (request, reply) => {
    const actor = await options.auth.assertWrite(request)
    const result = await options.service.create(actor.userId, String(request.headers['idempotency-key'] ?? ''), request.body.code_hash)
    return reply.code(201).send({ data: { pairing_id: result.pairingId, profile_id: result.profileId, expires_at: result.expiresAt }, meta: meta(request.id) })
  })
  app.post<{ Body: { pairing_code: string; installation_id: string; refresh_token: string } }>('/bridge/pairing-redemptions', {
    bodyLimit: 2048,
    schema: { body: { type: 'object', additionalProperties: false, required: ['pairing_code', 'installation_id', 'refresh_token'],
      properties: {
        pairing_code: { type: 'string', minLength: 47, maxLength: 47, pattern: '^bpc_[A-Za-z0-9_-]{43}$' },
        installation_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
        refresh_token: { type: 'string', minLength: 68, maxLength: 68, pattern: '^br4_[A-Za-z0-9_-]{64}$' },
      } } },
  }, async (request, reply) => {
    const body = request.body
    const result = await options.service.redeem(body.pairing_code, body.installation_id, body.refresh_token)
    return reply.code(201).send({ data: { credential_type: 'bridge_refresh', installation_id: result.installationId,
      profile_id: result.profileId, generation: result.generation,
      session_token_path: '/api/v4/bridge/session-tokens', websocket_path: '/bridge/v4/ws' }, meta: meta(request.id) })
  })
}

function meta(requestId: string) { return { request_id: requestId, generated_at: new Date().toISOString() } }
