import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { notificationRoutes } from '../src/modules/notifications/transport/routes.js'
import type { NotificationSettings } from '../src/modules/notifications/infrastructure/mysql-notifications.js'
it('accepts single and bulk reads and rejects ambiguous or invalid requests', async () => {
 const service = { markRead: vi.fn().mockResolvedValue({read:true}), markAllRead: vi.fn().mockResolvedValue({read:true}) }
 const auth = { authenticate:vi.fn().mockResolvedValue({userId:7}), assertWrite:vi.fn().mockResolvedValue({userId:7}) }
 const app = Fastify()
 await app.register(notificationRoutes,{service:service as unknown as NotificationSettings,auth})
 try {
  for (const payload of [{all:true},{id:'message-1'}]) expect((await app.inject({method:'POST',url:'/personal/notifications/read',payload})).statusCode).toBe(200)
  expect(service.markAllRead).toHaveBeenCalledWith(7)
  expect(service.markRead).toHaveBeenCalledWith(7,'message-1')
  for (const payload of [{},{all:false},{all:true,id:'message-1'},{all:true,userId:8}]) expect((await app.inject({method:'POST',url:'/personal/notifications/read',payload})).statusCode).toBe(400)
  expect(service.markAllRead).toHaveBeenCalledTimes(1)
  auth.assertWrite.mockRejectedValueOnce({status:403,code:'forbidden'})
  expect((await app.inject({method:'POST',url:'/personal/notifications/read',payload:{all:true}})).statusCode).toBe(403)
  expect(service.markAllRead).toHaveBeenCalledTimes(1)
 } finally { await app.close() }
})
