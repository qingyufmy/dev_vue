import type { FastifyError, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { BridgeInstallationService } from '../../application/bridge-installation-service.js'
import { BridgeInstallationError, type InstallationProof, type InstallationStart } from '../../domain/bridge-installation.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'

export interface BridgeInstallationRoutesOptions {
  service: BridgeInstallationService
  auth: {
    authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
    assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  }
}
const operations = ['startBridgeInstallationAuthorization', 'getBridgeInstallationAuthorization', 'decideBridgeInstallationAuthorization',
  'pollBridgeInstallationAuthorization', 'getBridgeInstallationStatus', 'registerBridgeInstallationProfile', 'revokeBridgeInstallation']
export const bridgeInstallationRoutes: FastifyPluginAsync<BridgeInstallationRoutesOptions> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, operations)
  const replyBody = (operation: string, data: unknown, requestId: string) => {
    try { return contract.response(operation, { data, meta: { request_id: requestId, generated_at: new Date().toISOString() } }, 200) }
    catch { throw new BridgeInstallationError(['startBridgeInstallationAuthorization', 'decideBridgeInstallationAuthorization', 'registerBridgeInstallationProfile', 'revokeBridgeInstallation'].includes(operation)
      ? 'bridge_installation_commit_unknown' : 'bridge_installation_response_invalid', 503) }
  }
  const validate = (operation: string, request: FastifyRequest, native = false) => {
    if (native && request.headers.origin !== undefined) throw new BridgeInstallationError('bridge_installation_origin_rejected', 403)
    if (Object.keys(request.query ?? {}).length) throw new HttpContractError('api_request_invalid', 400)
    contract.request(operation, request)
  }
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload })
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const known = error instanceof AuthError || error instanceof BridgeInstallationError || error instanceof HttpContractError
    const invalid = error.validation || ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_BODY_TOO_LARGE', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(error.code ?? '')
    const status = invalid ? 400 : known ? error.status : 503
    const code = invalid ? 'bridge_installation_request_invalid' : known ? error.code : 'bridge_installation_storage_failed'
    if (error instanceof BridgeInstallationError && error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds))
    return reply.code(status).type('application/problem+json').send({ type: `urn:aurum:problem:${code}`, title: 'Bridge installation authorization failed',
      status, code, detail: code, instance: request.url, correlation_id: request.id, retryable: status === 503 && code !== 'bridge_installation_commit_unknown' })
  })
  app.post<{ Body: InstallationStart }>('/bridge/installation-authorizations', { bodyLimit: 2048 }, async request => {
    validate(operations[0]!, request, true)
    return replyBody(operations[0]!, await options.service.start(request.body, request.ip), request.id)
  })
  app.get<{ Params: { authorization_id: string } }>('/bridge/installation-authorizations/:authorization_id', async request => {
    const actor = await options.auth.authenticate(request)
    validate(operations[1]!, request)
    return replyBody(operations[1]!, await options.service.confirmation(request.params.authorization_id, actor.userId), request.id)
  })
  app.post<{ Params: { authorization_id: string }; Body: { decision: 'approved' | 'denied'; expected_revision: string; current_user_id: string } }>(
    '/bridge/installation-authorizations/:authorization_id/decision', { bodyLimit: 1024 }, async request => {
      const actor = await options.auth.assertWrite(request)
      validate(operations[2]!, request)
      return replyBody(operations[2]!, await options.service.decide(request.params.authorization_id, actor.userId, String(request.headers['idempotency-key']), request.body), request.id)
    })
  app.post<{ Params: { authorization_id: string }; Body: { poll_secret: string; installation_token: string } }>(
    '/bridge/installation-authorizations/:authorization_id/poll', { bodyLimit: 1024 }, async request => {
      validate(operations[3]!, request, true)
      return replyBody(operations[3]!, await options.service.poll(request.params.authorization_id, request.body), request.id)
    })
  app.post<{ Body: InstallationProof }>('/bridge/installations/status', { bodyLimit: 1024 }, async request => {
    validate(operations[4]!, request, true)
    return replyBody(operations[4]!, await options.service.status(request.body), request.id)
  })
  app.post<{ Body: InstallationProof & { request_key: string; refresh_token: string } }>('/bridge/installations/profiles', { bodyLimit: 2048 }, async request => {
    validate(operations[5]!, request, true)
    return replyBody(operations[5]!, await options.service.registerProfile(request.body), request.id)
  })
  app.post<{ Body: InstallationProof }>('/bridge/installations/revoke', { bodyLimit: 1024 }, async request => {
    validate(operations[6]!, request, true)
    return replyBody(operations[6]!, await options.service.revoke(request.body), request.id)
  })
}
