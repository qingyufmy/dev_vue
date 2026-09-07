import { expect,it,vi,beforeEach } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlSettingManagement,settingRequestHash } from '../src/modules/settings/infrastructure/mysql-setting-management.js'
import { normalizeSettingCommand,SettingManagementService } from '../src/modules/settings/application/setting-management.js'
const mocks=vi.hoisted(()=>({write:vi.fn()}))
vi.mock('../src/modules/settings/infrastructure/mysql-setting-writer.js',()=>({updateSettingInTransaction:mocks.write}))
const input={actorUserId:1,requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',namespace:'smtp',key:'port',expectedType:'integer' as const,expectedRevision:'9007199254740993',value:'465'}
const receipt=()=>({request_sha256:settingRequestHash(input),setting_id:'1',revision:'9007199254740994',actor_user_id:'1',request_id:input.requestId})
function fixture(rows:unknown[]=[],allowed=true) {
 const execute=vi.fn(async(sql:string)=>sql.includes('SELECT id FROM users')?[allowed?[{id:1}]:[],[]]:sql.includes('FROM system_setting_requests')?[rows,[]]:[{},[]])
 const c={execute,query:vi.fn(),beginTransaction:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn(),destroy:vi.fn()}
 const getConnection=vi.fn(async()=>c)
 return {c,getConnection,repo:new MysqlSettingManagement({getConnection} as unknown as Pool)}
}
beforeEach(()=>{mocks.write.mockReset();mocks.write.mockImplementation(async(_c,command,validate)=>{
 if(!validate(command)) throw Error('setting_update_policy_rejected')
 return {id:'1',revision:'9007199254740994'}
})})
it('persists a receipt in the same transaction after the audited update',async()=>{
 const f=fixture();expect(await f.repo.execute(input)).toMatchObject({replayed:false,revision:'9007199254740994'})
 expect(mocks.write.mock.calls[0]![0]).toBe(f.c)
 expect(f.c.execute.mock.calls[2]).toEqual([expect.stringContaining('INSERT INTO system_setting_requests'),[1,input.requestId,settingRequestHash(input),'1','9007199254740994']])
 expect(f.c.commit).toHaveBeenCalledTimes(1);expect(f.c.release).toHaveBeenCalledTimes(1)
})
it('replays the original receipt without another setting update',async()=>{
 const f=fixture([receipt()]);expect(await f.repo.execute(input)).toEqual({id:'1',revision:'9007199254740994',replayed:true})
 expect(mocks.write).not.toHaveBeenCalled()
})
it('reauthorizes replay and rejects changed request payload or mismatched audit owner',async()=>{
 const denied=fixture([receipt()],false);await expect(denied.repo.execute(input)).rejects.toThrow('admin_required')
 expect(denied.c.execute).toHaveBeenCalledTimes(1)
 for(const row of [{...receipt(),request_sha256:'0'.repeat(64)},{...receipt(),actor_user_id:'2'}]) {
  const f=fixture([row]);await expect(f.repo.execute(input)).rejects.toThrow('idempotency_conflict');expect(f.c.rollback).toHaveBeenCalledTimes(1)
 }
 expect(mocks.write).not.toHaveBeenCalled()
})
it('destroys an uncertain commit connection and recovers through a later durable receipt',async()=>{
 const first=fixture();first.c.commit.mockRejectedValueOnce(Error('lost_ack'))
 await expect(first.repo.execute(input)).rejects.toThrow('setting_commit_unknown')
 expect(first.c.destroy).toHaveBeenCalledTimes(1);expect(first.c.rollback).not.toHaveBeenCalled();expect(first.c.release).not.toHaveBeenCalled()
 expect(await fixture([receipt()]).repo.execute(input)).toMatchObject({replayed:true});expect(mocks.write).toHaveBeenCalledTimes(1)
})
it('rolls back failed receipt insertion and destroys a failed rollback connection',async()=>{
 const f=fixture();f.c.execute.mockImplementation(async(sql:string)=>{
  if(sql.includes('INSERT INTO system_setting_requests')) throw Error('receipt_failed')
  return [sql.includes('SELECT id FROM users')?[{id:1}]:[],[]]
 })
 await expect(f.repo.execute(input)).rejects.toThrow('receipt_failed');expect(f.c.rollback).toHaveBeenCalledTimes(1);expect(f.c.commit).not.toHaveBeenCalled()
 const bad=fixture([],false);bad.c.rollback.mockRejectedValueOnce(Error('lost'))
 await expect(bad.repo.execute(input)).rejects.toThrow('rollback_unknown');expect(bad.c.destroy).toHaveBeenCalledTimes(1);expect(bad.c.release).not.toHaveBeenCalled()
})
it('uses runtime policy, rejects malformed commands and never trusts client actor IDs',async()=>{
 const f=fixture();await expect(f.repo.execute({...input,key:'host',expectedType:'string',value:'mail.example.com'})).rejects.toThrow('policy_rejected')
 expect(f.c.commit).not.toHaveBeenCalled()
 expect(()=>normalizeSettingCommand({...input,requestId:input.requestId+'\n'})).toThrow('invalid')
 const execute=vi.fn();const service=new SettingManagementService({execute})
 expect(()=>service.update({userId:1,role:'user'},input)).toThrow('admin_required')
 service.update({userId:2,role:'admin'},input);expect(execute).toHaveBeenCalledWith({...input,actorUserId:2})
 expect(settingRequestHash(input)).not.toBe(settingRequestHash({...input,value:'0465'}))
})
