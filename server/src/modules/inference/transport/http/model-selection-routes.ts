import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { InferenceError } from '../../domain/inference-error.js'
import type { ModelSelectionService } from '../../application/model-selection.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
interface Options {
  service: ModelSelectionService
  auth: { authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>; assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }> }
}
export const modelSelectionRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getModelSelection', 'setModelSelection'])
  for (const method of ['GET', 'PUT'] as const) app.route<{ Body: { model_profile_id: string; expected_model_profile_id: string | null } }>({ method, url: '/model-selection', async handler(request, reply) {
    reply.header('Cache-Control', 'no-store')
    const operation = method === 'GET' ? 'getModelSelection' : 'setModelSelection'
    try {
      const { userId } = await options.auth[method === 'GET' ? 'authenticate' : 'assertWrite'](request)
      if (Object.keys(request.query as object).length || method === 'GET' && request.body !== undefined) throw new HttpContractError('api_request_invalid', 400)
      contract.request(operation, request)
      const data = method === 'GET' ? await options.service.read(userId)
        : await options.service.select(userId, request.body.model_profile_id, request.body.expected_model_profile_id)
      return contract.response(operation, { data, meta: { request_id: request.id, generated_at: new Date().toISOString() } })
    } catch (error) {
      const known = error instanceof AuthError || error instanceof HttpContractError || error instanceof InferenceError ? error : new InferenceError('model_selection_unavailable', 503)
      return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Model selection failed', status: known.status, code: known.code, detail: known.code, instance: request.url, correlation_id: request.id })
    }
  } })
}
