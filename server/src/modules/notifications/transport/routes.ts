import type { FastifyPluginAsync } from 'fastify'
import type { NotificationSettings } from '../infrastructure/mysql-notifications.js'
import { createHttpContractValidator } from '../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../transport/generated/http-contracts.js'
interface Options { service: NotificationSettings; auth: { authenticate(r: {headers: Record<string,unknown>}): Promise<{userId:number}>; assertWrite(r: {headers: Record<string,unknown>}): Promise<{userId:number}> } }
export const notificationRoutes: FastifyPluginAsync<Options> = async (app, {service,auth}) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['getPersonalSettings','savePersonalSettings','getPersonalNotifications','readPersonalNotification'])
  for (const [method,url,operation] of [['GET','/personal/settings','getPersonalSettings'],['PUT','/personal/settings','savePersonalSettings'],['GET','/personal/notifications','getPersonalNotifications'],['POST','/personal/notifications/read','readPersonalNotification']] as const) {
    app.route({ method,url,bodyLimit:4096, async handler(request,reply) {
      reply.header('Cache-Control','no-store')
      try {
        const {userId} = await auth[method === 'GET' ? 'authenticate' : 'assertWrite'](request)
        contract.request(operation,request)
        const data = operation === 'getPersonalSettings' ? await service.read(userId)
          : operation === 'savePersonalSettings' ? await service.save(userId,request.body as Parameters<NotificationSettings['save']>[1],String(request.headers['idempotency-key'] ?? ''))
          : operation === 'getPersonalNotifications' ? await service.inbox(userId)
          : (request.body as {all?:boolean}).all === true ? await service.markAllRead(userId)
          : await service.markRead(userId,(request.body as {id:string}).id)
        return contract.response(operation,{data,meta:{request_id:request.id,generated_at:new Date().toISOString()}})
      } catch (error) {
        const e = error as {status?:number;code?:string}
        const status=e.status ?? 503, code=e.status ? e.code : 'notification_unavailable'
        return reply.code(status).send({type:`urn:aurum:problem:${code}`,title:'Notification request failed',status,code,detail:code,instance:request.url,correlation_id:request.id})
      }
    } })
  }
}
