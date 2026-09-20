import { InferenceError } from '../../domain/inference.js'
import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { HttpContractError, createHttpContractValidator } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { ArchivedSignalReader } from '../../application/archived-signal-reader.js'

interface Options { reader: ArchivedSignalReader; auth: { authenticate(request: { headers: Record<string,unknown> }): Promise<{ userId: number }> } }
const envelope = (id: string, data: unknown) => ({ data, meta: { request_id: id, generated_at: new Date().toISOString() } })
export const archivedSignalRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listArchivedSignals','getArchivedSignal'])
  for (const detail of [false,true]) {
    const operation = detail ? 'getArchivedSignal' : 'listArchivedSignals'
    app.get<{ Params: { legacy_id: string }; Querystring: { page_size?: string; cursor?: string } }>('/history/signals' + (detail ? '/:legacy_id' : ''), async (request,reply) => {
      reply.header('Cache-Control','no-store')
      try {
        const { userId } = await options.auth.authenticate(request)
        if (!Number.isSafeInteger(userId) || userId <= 0) throw new AuthError('authentication_required',401)
        if (Object.entries(request.query).some(([key,value]) => detail || !['page_size','cursor'].includes(key) || typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) throw new HttpContractError('api_request_invalid',400)
        contract.request(operation,request)
        const requestedId=detail ? request.params.legacy_id : request.query.cursor
        if (requestedId && BigInt(requestedId)>9223372036854775807n) throw new HttpContractError('api_request_invalid',400)
        const data = detail ? await options.reader.get(userId,request.params.legacy_id) : await options.reader.list(userId,{limit:Number(request.query.page_size ?? 20), ...(request.query.cursor ? { beforeId:request.query.cursor } : {})})
        if (!data) throw new InferenceError('archive_not_found',404)
        const value = 'items' in data ? { items:data.items, next_cursor:data.nextCursor } : data
        return contract.response(operation,envelope(request.id,{ ...value, identity_namespace:'retained-legacy', executable:false }))
      } catch (error) {
        const known=error instanceof AuthError || error instanceof HttpContractError || error instanceof InferenceError ? error : new InferenceError('archive_unavailable',503)
        const body={type:'urn:aurum:problem:'+known.code,title:'Archive read failed',status:known.status,code:known.code,
          detail:known.status>=500 ? '历史记录暂时不可用，请稍后重试。' : '无法读取该历史记录。',instance:request.url.split('?')[0],correlation_id:request.id,retryable:known.status>=500}
        return reply.code(known.status).type('application/problem+json').send(contract.response(operation,body,known.status,'application/problem+json'))
      }
    })
  }
}
