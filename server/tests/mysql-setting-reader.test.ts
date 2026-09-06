import { expect,it,vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { readSetting } from '../src/modules/settings/index.js'
const row=()=>({id:'1',namespace:'fixture',setting_key:'key',value_type:'string',sensitivity:'restricted',revision:'9007199254740993',value_state:'text',readable_value:'value'})
function fixture(rows: unknown[]) {const execute=vi.fn(async()=>[rows,[]]);return {execute,c:{execute} as unknown as Pick<PoolConnection,'execute'>}}
const input={namespace:'fixture',key:'key',expectedType:'string' as const}
it('distinguishes missing, NULL and empty without fallback and preserves revision precision',async()=>{
 expect(await readSetting(fixture([]).c,input)).toEqual({status:'missing'})
 for(const [value,state] of [[null,'null'],['','empty'],['value','text']]){
  expect(await readSetting(fixture([{...row(),readable_value:value,value_state:state}]).c,input)).toMatchObject({status:'found',rawValue:value,valueState:state,metadata:{revision:'9007199254740993'}})
 }
})
it('redacts credentials in SQL and never returns their raw value',async()=>{
 const f=fixture([{...row(),value_type:'credential',sensitivity:'secret',readable_value:null}])
 const result=await readSetting(f.c,{...input,expectedType:'credential'})
 expect(result.status).toBe('protected');expect(result).not.toHaveProperty('rawValue')
 expect(f.execute.mock.calls[0]).toEqual([expect.stringContaining("sensitivity='secret' OR value_type='credential' THEN NULL"),['fixture','key']])
 await expect(readSetting(fixture([{...row(),sensitivity:'secret'}]).c,input)).rejects.toThrow('redaction_invalid')
})
it('rejects malformed scope before SQL and wrong type or identity after SQL',async()=>{
 const f=fixture([]);await expect(readSetting(f.c,{...input,key:'key\n'})).rejects.toThrow('scope_invalid');expect(f.execute).not.toHaveBeenCalled()
 for(const patch of [{revision:'01'},{id:'1\n'},{namespace:'another'},{value_type:'boolean'}])await expect(readSetting(fixture([{...row(),...patch}]).c,input)).rejects.toThrow('state_invalid')
 await expect(readSetting(fixture([row(),row()]).c,input)).rejects.toThrow('state_invalid')
})
it('keeps integer and JSON text exact and rejects coercion or invalid shape',async()=>{
 for(const [type,value] of [['integer','9007199254740993'],['json_array','[ 1, 2 ]']] as const)expect(await readSetting(fixture([{...row(),value_type:type,readable_value:value}]).c,{...input,expectedType:type})).toMatchObject({rawValue:value})
 for(const [type,value] of [['boolean','1'],['boolean','true\n'],['integer','01'],['json_array','{}']] as const)await expect(readSetting(fixture([{...row(),value_type:type,readable_value:value}]).c,{...input,expectedType:type})).rejects.toThrow()
})
