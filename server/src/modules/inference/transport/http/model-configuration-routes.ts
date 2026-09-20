import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { InferenceError } from '../../domain/inference-error.js'
import type { ModelConfigurationService, ModelConfigurationChange } from '../../application/model-configuration.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
interface Options { service: ModelConfigurationService; auth: { authenticate(request: {headers: Record<string,unknown>}): Promise<{userId:number}>; assertWrite(request: {headers: Record<string,unknown>}): Promise<{userId:number}> } }
export const modelConfigurationRoutes: FastifyPluginAsync<Options> = async (app, options) => {
 const contract=createHttpContractValidator(httpRuntimeContracts,['listModelConfigurations','saveModelConfiguration','verifyModelConfiguration','createModelConfiguration','deleteModelConfiguration','getModelAssignments','setModelAssignments'])
 for(const [method,url,operation] of [['GET','/model-assignments','getModelAssignments'],['PUT','/model-assignments','setModelAssignments'],['POST','/model-configurations','createModelConfiguration'],['DELETE','/model-configurations/:id','deleteModelConfiguration'],['GET','/model-configurations','listModelConfigurations'],['PUT','/model-configurations/:id','saveModelConfiguration'],['POST','/model-configurations/:id/verification','verifyModelConfiguration']] as const) {
  app.route<{Params:{id:string};Body:ModelConfigurationChange}>({method,url,bodyLimit:16384,async handler(request,reply) {
   reply.header('Cache-Control','no-store')
   try {
    const {userId}=await options.auth[method==='GET' ? 'authenticate':'assertWrite'](request)
    if(Object.keys(request.query as object).length) throw new HttpContractError('api_request_invalid',400)
    contract.request(operation,request)
    const data=operation==='getModelAssignments'?await options.service.readAssignments(userId):operation==='setModelAssignments'?await options.service.saveAssignments(userId,String(request.headers['idempotency-key']),request.body as unknown as Parameters<ModelConfigurationService['saveAssignments']>[2]):operation==='createModelConfiguration'?await options.service.save(userId,'new',String(request.headers['idempotency-key']),request.body):operation==='deleteModelConfiguration'?await options.service.remove(userId,request.params.id,String(request.headers['idempotency-key']),request.body.expected_revision):method==='GET' ? await options.service.list(userId) : method==='PUT' ? await options.service.save(userId,request.params.id,String(request.headers['idempotency-key']),request.body) : await options.service.verify(userId,request.params.id,String(request.headers['idempotency-key']),request.body.expected_revision)
    return contract.response(operation,{data,meta:{request_id:request.id,generated_at:new Date().toISOString()}})
   } catch(error) {
    const known=error instanceof AuthError || error instanceof InferenceError || error instanceof HttpContractError ? error : new InferenceError('model_configuration_unavailable',503)
    return reply.code(known.status).send({type:`urn:aurum:problem:${known.code}`,title:'Model configuration failed',status:known.status,code:known.code,detail:known.code,instance:request.url,correlation_id:request.id})
   }
  }})
 }
}
