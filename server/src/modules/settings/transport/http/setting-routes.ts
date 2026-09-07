import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { SettingManagementService,SettingChangeCommand } from '../../application/setting-management.js'
interface Options {
 service:SettingManagementService
 auth:{assertWrite(request:{headers:Record<string,unknown>}):Promise<{userId:number;role:string}>}
}
const statuses:Record<string,number>={setting_admin_required:403,setting_command_invalid:400,setting_command_policy_rejected:422,
 setting_update_policy_rejected:422,setting_revision_conflict:409,setting_idempotency_conflict:409,
 setting_commit_unknown:503,setting_rollback_unknown:503}
export const settingRoutes:FastifyPluginAsync<Options>=async(app,options)=>{
 app.put<{Body:unknown}>('/value',async(request,reply)=>{
  reply.header('Cache-Control','no-store')
  try {
   const actor=await options.auth.assertWrite(request)
   const body=request.body
   const requestId=request.headers['idempotency-key']
   if(Object.keys(request.query as object).length || typeof requestId!=='string' || !body || typeof body!=='object'
    || Array.isArray(body) || Object.keys(body).sort().join(',')!=='expected_revision,key,namespace,value,value_type') throw Error('setting_command_invalid')
   const row=body as Record<string,unknown>
   const result=await options.service.update(actor,{requestId,namespace:row.namespace as string,key:row.key as string,
    expectedType:row.value_type as SettingChangeCommand['expectedType'],expectedRevision:row.expected_revision as string,value:row.value as string|null})
   return {data:{setting_id:result.id,revision:result.revision,replayed:result.replayed},meta:{request_id:request.id,generated_at:new Date().toISOString()}}
  } catch(error) {
   const code=error instanceof AuthError?error.code:error instanceof Error && Object.hasOwn(statuses,error.message)?error.message:'setting_update_unavailable'
   const status=error instanceof AuthError?error.status:statuses[code]??503
   return reply.code(status).send({type:`urn:aurum:problem:${code}`,title:'配置更新失败',status,code,
    detail:status===503?'暂时无法确认结果，请保留原请求编号和内容。':'请检查权限、配置内容及版本。',
    instance:request.url,correlation_id:request.id,retryable:status===503})
  }
 })
}
