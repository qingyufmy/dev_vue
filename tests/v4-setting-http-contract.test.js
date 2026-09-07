import { readFile } from 'node:fs/promises'
import Ajv from 'ajv'
import { expect,it } from 'vitest'
const doc=JSON.parse(await readFile(new URL('../contracts/openapi-v4.json',import.meta.url),'utf8'))
const operation=doc.paths['/admin/settings/value'].put
const ajv=new Ajv({strict:false,formats:{'date-time':true}})
it('accepts exact text values and string versions but rejects actor injection and credentials',()=>{
 const validate=ajv.compile(operation.requestBody.content['application/json'].schema)
 const body={namespace:'smtp',key:'port',value_type:'integer',expected_revision:'9007199254740993',value:'465'}
 expect(validate(body)).toBe(true)
 for(const value of [{...body,actor_user_id:2},{...body,expected_revision:1},{...body,value:465},{...body,value_type:'credential'}]) expect(validate(value)).toBe(false)
})
it('describes durable result and bounded UUID idempotency key',()=>{
 const validate=ajv.compile(operation.responses['200'].content['application/json'].schema)
 expect(validate({data:{setting_id:'1',revision:'9007199254740994',replayed:true},meta:{request_id:'r',generated_at:'2026-09-07T00:00:00.000Z'}})).toBe(true)
 const header=ajv.compile(operation.parameters.find(p=>p.name==='Idempotency-Key').schema)
 expect(header('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true)
 expect(header('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n')).toBe(false)
})
it('describes protected responses without allowing a leaked value field',()=>{
 const get=doc.paths['/admin/settings/value'].get
 const validate=ajv.compile(get.responses['200'].content['application/json'].schema)
 const data={setting_id:'1',namespace:'smtp',key:'pass',value_type:'credential',sensitivity:'secret',revision:'1',value_state:'text',protected:true}
 const meta={request_id:'r',generated_at:'2026-09-07T00:00:00.000Z'}
 expect(validate({data,meta})).toBe(true)
 expect(validate({data:{...data,value:'ciphertext'},meta})).toBe(false)
 expect(validate({data:{...data,protected:false,value:null},meta})).toBe(false)
 expect(validate({data:{...data,key:'host',value_type:'string',sensitivity:'restricted',protected:false,value:null,value_state:'null'},meta})).toBe(true)
})
