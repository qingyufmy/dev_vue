import { createHttpContractValidator } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import { settingHttpFailure } from './setting-http-failure.js'
import type { FastifyPluginAsync } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { AdminSettingReader } from '../../application/admin-setting-reader.js'
interface Options { service:AdminSettingReader;auth:{authenticate(request:{headers:Record<string,unknown>}):Promise<{userId:number;role:string}>} }
const statuses:Record<string,number>={setting_admin_required:403,setting_read_request_invalid:400,setting_missing:404}
export const adminSettingReadRoutes:FastifyPluginAsync<Options>=async(app,options)=>{
 const contract=createHttpContractValidator(httpRuntimeContracts,['readAdminSystemSetting'])
 app.get('/value',async(request,reply)=>{
  reply.header('Cache-Control','no-store')
  try {
   const actor=await options.auth.authenticate(request)
   try { contract.request('readAdminSystemSetting',request) } catch { throw Error('setting_read_request_invalid') }
   const query=request.query as Record<string,unknown>
   if(Object.keys(query).sort().join(',')!=='key,namespace'||typeof query.namespace!=='string'||typeof query.key!=='string') throw Error('setting_read_request_invalid')
   const result=await options.service.read(actor,{namespace:query.namespace,key:query.key})
   if(result.status==='missing')throw Error('setting_missing')
   const metadata=result.metadata
   return contract.response('readAdminSystemSetting',{data:{setting_id:metadata.id,namespace:metadata.namespace,key:metadata.key,value_type:metadata.type,
    sensitivity:metadata.sensitivity,revision:metadata.revision,value_state:result.valueState,protected:result.status==='protected',
    ...(result.status==='found'?{value:result.rawValue}:{})},meta:{request_id:request.id,generated_at:new Date().toISOString()}})
  } catch(error) {
   const code=error instanceof AuthError?error.code:error instanceof Error&&Object.hasOwn(statuses,error.message)?error.message:'setting_read_unavailable'
   const status=error instanceof AuthError?error.status:statuses[code]??503
   return settingHttpFailure(reply,contract,'readAdminSystemSetting',{type:`urn:aurum:problem:${code}`,title:'配置读取失败',status,code,
    detail:'请检查权限及配置项后重试。',instance:'/api/v4/admin/settings/value',correlation_id:request.id,retryable:status===503})
  }
 })
}
