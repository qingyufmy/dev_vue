import Fastify from 'fastify'
import type { Pool } from 'mysql2/promise'
import { expect,it,vi } from 'vitest'
import { AdminSettingReader,MysqlAdminSettingReader,adminSettingReadRoutes } from '../src/modules/settings/management.js'
const metadata={id:'1',namespace:'smtp',key:'port',type:'integer',sensitivity:'restricted',revision:'9007199254740993'}
async function fixture() {
 const read=vi.fn().mockResolvedValue({status:'found',metadata,valueState:'text',rawValue:'465'})
 const auth={authenticate:vi.fn().mockResolvedValue({userId:1,role:'admin'})}
 const app=Fastify();await app.register(adminSettingReadRoutes,{prefix:'/api/v4/admin/settings',service:new AdminSettingReader({read}),auth})
 const send=(query='namespace=smtp&key=port')=>app.inject('/api/v4/admin/settings/value?'+query)
 return {read,auth,app,send}
}
it('returns exact versions and distinguishes missing, NULL and empty',async()=>{
 const f=await fixture();try {
  const r=await f.send();expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.json().data.revision).toBe(metadata.revision)
  for(const [rawValue,valueState] of [[null,'null'],['','empty']]) {
   f.read.mockResolvedValueOnce({status:'found',metadata,rawValue,valueState});expect((await f.send()).json().data).toMatchObject({value:rawValue,value_state:valueState})
  }
  f.read.mockResolvedValueOnce({status:'missing'});expect((await f.send()).statusCode).toBe(404)
 }finally{await f.app.close()}
})
it('never returns a value property for protected credentials',async()=>{
 const f=await fixture();try {
  f.read.mockResolvedValueOnce({status:'protected',metadata:{...metadata,key:'pass',type:'credential',sensitivity:'secret'},valueState:'text'})
  const r=await f.send('namespace=smtp&key=pass');expect(r.statusCode).toBe(200);expect(r.json().data.protected).toBe(true);expect(r.json().data).not.toHaveProperty('value')
  expect(f.read).toHaveBeenCalledWith(1,{namespace:'smtp',key:'pass',expectedType:'credential'})
 }finally{await f.app.close()}
})
it('rejects non-admin, unknown keys, extra or repeated query fields',async()=>{
 const f=await fixture();try {
  f.auth.authenticate.mockResolvedValueOnce({userId:1,role:'user'});expect((await f.send()).statusCode).toBe(403)
  for(const q of ['namespace=smtp&key=nope','namespace=smtp&key=port&actor=2','namespace=smtp&key=port&key=pass'])expect((await f.send(q)).statusCode).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
 }finally{await f.app.close()}
})
it('database authorization precedes value reads and read transactions are rolled back',async()=>{
 const execute=vi.fn().mockResolvedValueOnce([[{id:1}],[]]).mockResolvedValueOnce([[{id:'1',namespace:'smtp',setting_key:'port',value_type:'integer',sensitivity:'restricted',revision:'9007199254740993',value_state:'text',readable_value:'465'}],[]])
 const c={execute,query:vi.fn(),beginTransaction:vi.fn(),rollback:vi.fn(),release:vi.fn(),destroy:vi.fn()}
 const repo=new MysqlAdminSettingReader({getConnection:async()=>c} as unknown as Pool)
 expect(await repo.read(1,{namespace:'smtp',key:'port',expectedType:'integer'})).toMatchObject({status:'found',rawValue:'465'})
 expect(execute.mock.calls[0]).toEqual([expect.stringContaining('FOR SHARE'),[1]])
 expect(c.rollback).toHaveBeenCalledTimes(1);expect(c.release).toHaveBeenCalledTimes(1)
 execute.mockReset().mockResolvedValueOnce([[],[]]);await expect(repo.read(1,{namespace:'smtp',key:'port',expectedType:'integer'})).rejects.toThrow('admin_required');expect(execute).toHaveBeenCalledTimes(1)
})
