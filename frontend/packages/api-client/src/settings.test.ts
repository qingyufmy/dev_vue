import { expect,it,vi } from 'vitest'
import { createApiClient } from './index'
const meta={request_id:'r',generated_at:'2026-09-07T00:00:00.000Z'}
const key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const body={namespace:'smtp',key:'port',value_type:'integer' as const,expected_revision:'9007199254740993',value:'465'}
it('sends CSRF and exact idempotency key without retry or value coercion',async()=>{
 const fetchImpl=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({data:{setting_id:'1',revision:'9007199254740994',replayed:true},meta})))
 await createApiClient({fetchImpl}).updateAdminSetting(body,key,'csrf')
 const [url,init]=fetchImpl.mock.calls[0]!
 expect(url).toBe('/api/v4/admin/settings/value');expect(init?.body).toBe(JSON.stringify(body));expect(init?.credentials).toBe('same-origin')
 expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(key);expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf');expect(fetchImpl).toHaveBeenCalledTimes(1)
})
it('rejects protected value leaks and inconsistent NULL state',async()=>{
 const data={setting_id:'1',namespace:'smtp',key:'pass',value_type:'credential',revision:'1',sensitivity:'secret',protected:true,value_state:'text'}
 const fetchImpl=vi.fn<typeof fetch>()
 for(const row of [{...data,value:'cipher'},{...data,protected:false,value:'cipher'}, {...data,key:'host',value_type:'string',sensitivity:'restricted',protected:false,value:null}]){
  fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({data:row,meta})))
  await expect(createApiClient({fetchImpl}).getAdminSetting({namespace:'smtp',key:'pass'})).rejects.toThrow()
 }
 fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({data,meta})))
 expect((await createApiClient({fetchImpl}).getAdminSetting({namespace:'smtp',key:'pass'})).data).not.toHaveProperty('value')
})
it('rejects invalid request keys before sending',()=>{
 const fetchImpl=vi.fn<typeof fetch>();expect(()=>createApiClient({fetchImpl}).updateAdminSetting(body,key+'\n','csrf')).toThrow();expect(fetchImpl).not.toHaveBeenCalled()
})
