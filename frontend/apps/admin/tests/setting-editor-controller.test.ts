import { expect,it,vi } from 'vitest'
import { createSettingEditorController } from '../src/features/settings/setting-editor-controller'
const meta={request_id:'r',generated_at:'2026-09-07T00:00:00.000Z'}
const data={setting_id:'1',namespace:'smtp',key:'port',value_type:'integer' as const,sensitivity:'restricted' as const,revision:'1',value_state:'text' as const,protected:false as const,value:'465'}
const scope={namespace:'smtp',key:'port'}
const key=()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
it('ignores late responses after switching configuration',async()=>{
 let resolve!:(r:unknown)=>void
 const getAdminSetting=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValueOnce({data:{...data,key:'secure',value_type:'boolean',value:'true'},meta})
 const c=createSettingEditorController({getAdminSetting,updateAdminSetting:vi.fn()},'1',key)
 const old=c.load('1',scope);await c.load('1',{namespace:'smtp',key:'secure'});resolve({data,meta});expect(await old).toBe(false)
 expect(c.snapshot().current?.key).toBe('secure')
})
it('blocks switching during uncertain writes and refreshes after exact recovery',async()=>{
 const getAdminSetting=vi.fn().mockResolvedValue({data,meta})
 const updateAdminSetting=vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce({data:{setting_id:'1',revision:'2',replayed:true},meta})
 const c=createSettingEditorController({getAdminSetting,updateAdminSetting},'1',key)
 await c.load('1',scope);await expect(c.save('1','587','csrf')).rejects.toThrow('network')
 await expect(c.load('1',{namespace:'smtp',key:'host'})).rejects.toThrow('unresolved')
 getAdminSetting.mockResolvedValueOnce({data:{...data,value:'587',revision:'2'},meta})
 await c.recover('1','csrf-new');expect(updateAdminSetting.mock.calls[1]).toEqual([expect.objectContaining({key:'port',value:'587',expected_revision:'1'}),key(),'csrf-new'])
 expect(c.snapshot().current?.revision).toBe('2')
})
it('invalidates a saved form when post-commit refresh fails without retrying the write',async()=>{
 const getAdminSetting=vi.fn().mockResolvedValueOnce({data,meta}).mockRejectedValueOnce(Error('read_failed'))
 const updateAdminSetting=vi.fn().mockResolvedValue({data:{setting_id:'1',revision:'2',replayed:false},meta})
 const c=createSettingEditorController({getAdminSetting,updateAdminSetting},'1',key)
 await c.load('1',scope);await c.save('1','587','csrf')
 expect(c.snapshot()).toMatchObject({current:null,error:'setting_read_unavailable',write:{phase:'complete',pending:null}})
 expect(updateAdminSetting).toHaveBeenCalledTimes(1)
})
it('rejects protected and cross-user writes and clears suspended read data',async()=>{
 const getAdminSetting=vi.fn().mockResolvedValue({data:{...data,key:'pass',value_type:'credential',sensitivity:'secret',protected:true},meta})
 const updateAdminSetting=vi.fn();const c=createSettingEditorController({getAdminSetting,updateAdminSetting},'1',key)
 await c.load('1',{namespace:'smtp',key:'pass'});await expect(c.save('1','x','csrf')).rejects.toThrow('not_editable')
 await expect(c.save('2','x','csrf')).rejects.toThrow('actor_changed');c.suspend();expect(c.snapshot().current).toBe(null);expect(updateAdminSetting).not.toHaveBeenCalled()
})
it('does not repopulate read data after suspension during an in-flight write',async()=>{
 let resolve!:(r:unknown)=>void
 const getAdminSetting=vi.fn().mockResolvedValue({data,meta})
 const updateAdminSetting=vi.fn().mockImplementation(()=>new Promise(r=>{resolve=r}))
 const c=createSettingEditorController({getAdminSetting,updateAdminSetting},'1',key)
 await c.load('1',scope);const saving=c.save('1','587','csrf');c.suspend()
 resolve({data:{setting_id:'1',revision:'2',replayed:false},meta});await saving
 expect(c.snapshot().current).toBe(null);expect(getAdminSetting).toHaveBeenCalledTimes(1)
})
