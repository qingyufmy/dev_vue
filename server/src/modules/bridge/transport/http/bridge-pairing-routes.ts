import type { FastifyError, FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { BridgePairingError, type BridgePairingService } from '../../application/bridge-pairing-service.js'
import { BridgeCredentialError } from '../../domain/bridge-credential.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export interface BridgePairingRoutesOptions {
  service: BridgePairingService
  auth: { assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }> }
}

export const bridgePairingRoutes: FastifyPluginAsync<BridgePairingRoutesOptions> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['createBridgePairingRequest', 'redeemBridgePairing'])
  const resultBody = (operation: string, build: () => unknown) => {
    try { return contract.response(operation, build(), 201) }
    catch { throw new BridgePairingError('bridge_pairing_commit_unknown', 503) }
  }
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const known = error instanceof AuthError || error instanceof BridgePairingError || error instanceof BridgeCredentialError || error instanceof HttpContractError
    const invalid = error.validation || ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_BODY_TOO_LARGE', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(error.code ?? '')
    const status = invalid ? 400 : known ? error.status : 503
    const code = invalid ? 'bridge_pairing_request_invalid' : known ? error.code : 'bridge_pairing_storage_failed'
    const operation = request.routeOptions.url?.endsWith('/pairing-requests') ? 'createBridgePairingRequest' : 'redeemBridgePairing'
    const body = { type: `urn:aurum:problem:${code}`, title: 'Bridge pairing request failed',
      status, code, detail: code, instance: request.url, correlation_id: request.id,
      retryable: status === 503 && code !== 'bridge_pairing_commit_unknown' }
    return reply.type('application/problem+json').code(status).send(contract.response(operation, body, status, 'application/problem+json'))
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store')
    return payload
  })
  app.post<{ Body: { code_hash: string } }>('/bridge/pairing-requests', {
    bodyLimit: 1024,
  }, async (request, reply) => {
    const actor = await options.auth.assertWrite(request)
    if (Object.keys(request.query ?? {}).length) throw new HttpContractError('api_request_invalid', 400)
    contract.request('createBridgePairingRequest', request)
    const result = await options.service.create(actor.userId, String(request.headers['idempotency-key'] ?? ''), request.body.code_hash)
    return reply.code(201).send(resultBody('createBridgePairingRequest', () => ({ data: { pairing_id: result.pairingId, profile_id: result.profileId, expires_at: result.expiresAt }, meta: meta(request.id) })))
  })
  app.post<{ Body: { pairing_code: string; installation_id: string; refresh_token: string } }>('/bridge/pairing-redemptions', {
    bodyLimit: 2048,
  }, async (request, reply) => {
    if (Object.keys(request.query ?? {}).length) throw new HttpContractError('api_request_invalid', 400)
    contract.request('redeemBridgePairing', request)
    const body = request.body
    const result = await options.service.redeem(body.pairing_code, body.installation_id, body.refresh_token)
    return reply.code(201).send(resultBody('redeemBridgePairing', () => ({ data: { credential_type: 'bridge_refresh', installation_id: result.installationId,
      profile_id: result.profileId, generation: result.generation,
      session_token_path: '/api/v4/bridge/session-tokens', websocket_path: '/bridge/v4/ws' }, meta: meta(request.id) })))
  })
}

function meta(requestId: string) { return { request_id: requestId, generated_at: new Date().toISOString() } }
