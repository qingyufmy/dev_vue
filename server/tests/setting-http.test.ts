import Fastify from 'fastify'
import { expect,it,vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { SettingManagementService, AdminSettingReader } from '../src/modules/settings/index.js'
import { createSettingsHttp } from '../src/modules/settings/composition.js'
import { exactAdminHostHook } from '../src/transport/api-v4-route-registrar.js'
const body={namespace:'smtp',key:'port',value_type:'integer',expected_revision:'9007199254740993',value:'465'}
async function fixture() {
 const execute=vi.fn().mockResolvedValue({id:'1',revision:'9007199254740994',replayed:false})
 const auth={assertWrite:vi.fn().mockResolvedValue({userId:1,role:'admin'}),authenticate:vi.fn().mockResolvedValue({userId:1,role:'admin'})}
 const app=Fastify();app.addHook('onRequest',exactAdminHostHook('https://admin.example.test'))
 await app.register(createSettingsHttp({read:new AdminSettingReader({read:async()=>({status:'missing'})}),write:new SettingManagementService({execute})},auth))
 const send=(payload:unknown=body,headers={},suffix='')=>app.inject({method:'PUT',url:'/api/v4/admin/settings/value'+suffix,
  headers:{host:'admin.example.test','idempotency-key':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',...headers},payload:payload as object})
 return {app,send,execute,auth}
}
it('uses the verified actor and exact revisions without returning config values',async()=>{
 const f=await fixture();try {
  const r=await f.send();expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store')
  expect(r.json().data).toEqual({setting_id:'1',revision:'9007199254740994',replayed:false})
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({actorUserId:1,value:'465',expectedRevision:'9007199254740993'}))
 }finally{await f.app.close()}
})
it('rejects wrong host, CSRF failure and non-admin sessions before persistence',async()=>{
 const f=await fixture();try {
  expect((await f.send(body,{host:'trade.example.test'})).statusCode).toBe(421)
  f.auth.assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid',403));expect((await f.send()).statusCode).toBe(403)
  f.auth.assertWrite.mockResolvedValueOnce({userId:1,role:'user'});expect((await f.send()).statusCode).toBe(403)
  expect(f.execute).not.toHaveBeenCalled()
 }finally{await f.app.close()}
})
it('rejects extra fields, query parameters, numeric revisions and protected keys',async()=>{
 const f=await fixture();try {
  for(const value of [{...body,actor_user_id:2},{...body,expected_revision:1},{...body,value:465}]) expect((await f.send(value)).statusCode).toBeGreaterThanOrEqual(400)
  expect((await f.send(body,{},'?actor=2')).statusCode).toBe(400)
  expect((await f.send({...body,key:'pass',value_type:'credential'})).statusCode).toBe(422)
  expect(f.execute).not.toHaveBeenCalled()
 }finally{await f.app.close()}
})
it('reports conflicts and uncertain results without exposing SQL or config text',async()=>{
 const f=await fixture();try {
  for(const [code,status] of [['setting_revision_conflict',409],['setting_idempotency_conflict',409],['setting_commit_unknown',503],['SELECT secret FROM settings',503]] as const) {
   f.execute.mockRejectedValueOnce(Error(code));const r=await f.send();expect(r.statusCode).toBe(status);expect(r.body).not.toContain('SELECT secret')
  }
 }finally{await f.app.close()}
})
