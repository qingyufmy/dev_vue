import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { HttpContractError,createHttpContractValidator } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import { TradeHistoryError } from '../../domain/trade-history.js'
import type { ArchivedExecutionDeals } from '../../application/archived-execution-deals.js'
import type { TradeHistoryRequestAuthenticator } from './trade-history-routes.js'

export const archivedExecutionDealRoutes: FastifyPluginAsync<{reader: Pick<ArchivedExecutionDeals,'list'>;auth:TradeHistoryRequestAuthenticator}> = async (app,options)=>{
  const operation='listArchivedExecutionDeals'
  const contract=createHttpContractValidator(httpRuntimeContracts,[operation])
  app.get<{Params:{legacy_id:string};Querystring:{page_size?:string;cursor?:string}}>('/history/executions/:legacy_id/deals',async(request,reply)=>{
    reply.header('Cache-Control','no-store')
    try {
      const {userId}=await options.auth.authenticate(request)
      if (!Number.isSafeInteger(userId) || userId<=0) throw new AuthError('authentication_required',401)
      if(Object.entries(request.query).some(([key,value])=>!['page_size','cursor'].includes(key) || typeof value!=='string' || !/^[1-9][0-9]*$/.test(value))) throw new HttpContractError('api_request_invalid',400)
      contract.request(operation,request)
      const data=await options.reader.list(userId,request.params.legacy_id,{limit:Number(request.query.page_size??20),...(request.query.cursor?{beforeId:request.query.cursor}:{})})
      return contract.response(operation,{data:{...data,legacy_execution_id:request.params.legacy_id,identity_namespace:'retained-legacy',executable:false},meta:{request_id:request.id,generated_at:new Date().toISOString()}})
    }catch(error){
      const known=error instanceof AuthError || error instanceof HttpContractError || error instanceof TradeHistoryError ? error : new TradeHistoryError('archive_unavailable',503)
      return reply.code(known.status).type('application/problem+json').send(contract.response(operation,{type:'urn:aurum:problem:'+known.code,title:'Historical deal read failed',status:known.status,code:known.code,detail:'暂时无法读取该成交记录。',instance:request.url.split('?')[0],correlation_id:request.id,retryable:known.status>=500},known.status,'application/problem+json'))
    }
  })
}
