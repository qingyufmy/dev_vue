import { expect,it,vi } from 'vitest'
import { ApiClientError } from '@aurum/api-client'
import { createSettingWriteSession } from '../src/features/settings/setting-write-session'
const body={namespace:'smtp',key:'port',value_type:'integer' as const,expected_revision:'9007199254740993',value:'465'}
const result={data:{setting_id:'1',revision:'9007199254740994',replayed:true},meta:{request_id:'r',generated_at:'2026-09-07T00:00:00.000Z'}}
const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
it('freezes uncertain requests and recovers with the same body and key',async()=>{
 const updateAdminSetting=vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce(result)
 const state=createSettingWriteSession({updateAdminSetting},'1',()=>key)
 const draft={...body};await expect(state.submit('1',draft,'csrf-a')).rejects.toThrow('network');draft.value='999'
 const snapshot=state.snapshot();snapshot.pending!.body.value='888'
 await expect(state.submit('1',body,'csrf-a')).rejects.toThrow('unresolved')
 expect(await state.recover('1','csrf-b')).toEqual(result)
 expect(updateAdminSetting.mock.calls[1]).toEqual([body,key,'csrf-b']);expect(state.snapshot()).toEqual({phase:'complete',pending:null})
})
it('rejects cross-user recovery and retains uncertainty after denied recovery',async()=>{
 const updateAdminSetting=vi.fn().mockRejectedValueOnce(Error('network')).mockRejectedValueOnce(new ApiClientError(403,null))
 const state=createSettingWriteSession({updateAdminSetting},'1',()=>key)
 await expect(state.submit('1',body,'csrf')).rejects.toThrow()
 await expect(state.recover('2','csrf')).rejects.toThrow('actor_changed')
 await expect(state.recover('1','csrf')).rejects.toThrow()
 expect(state.snapshot().phase).toBe('uncertain');expect(state.snapshot().pending?.requestKey).toBe(key)
})
it('clears definite first rejection but keeps mismatched success uncertain',async()=>{
 const updateAdminSetting=vi.fn().mockRejectedValueOnce(new ApiClientError(422,{type:'urn:aurum:problem:setting_command_policy_rejected',title:'rejected',status:422,code:'setting_command_policy_rejected',detail:'rejected',instance:'/api/v4/admin/settings/value',correlation_id:'r',retryable:false})).mockResolvedValueOnce({...result,data:{...result.data,revision:'2'}})
 const state=createSettingWriteSession({updateAdminSetting},'1',()=>key)
 await expect(state.submit('1',body,'csrf')).rejects.toThrow();expect(state.snapshot()).toEqual({phase:'rejected',pending:null})
 await expect(state.submit('1',body,'csrf')).rejects.toThrow('revision_invalid');expect(state.snapshot().phase).toBe('uncertain')
})
it('does not treat a proxy HTTP failure as proof the write was rejected',async()=>{
 const updateAdminSetting=vi.fn().mockRejectedValue(new ApiClientError(408,null))
 const state=createSettingWriteSession({updateAdminSetting},'1',()=>key)
 await expect(state.submit('1',body,'csrf')).rejects.toThrow();expect(state.snapshot().phase).toBe('uncertain')
})
