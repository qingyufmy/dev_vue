import { expect,it } from 'vitest'
import { inspectSettingUpdate,settingValueRules,validateSettingValueForWrite } from '../src/modules/settings/domain/setting-value-policy.js'
// @ts-expect-error Frozen migration module has no TypeScript declaration.
import { settingsValueContracts } from '../../scripts/lib/v4-settings-value-contract.mjs'
const input={namespace:'smtp',key:'port',expectedType:'integer' as const,value:'465'}
it('covers all 59 frozen source contracts without changing import rules',()=>{
 expect(settingValueRules().filter(rule=>rule.namespace!=='market_data')).toEqual(settingsValueContracts())
 expect(settingValueRules().filter(rule=>rule.namespace==='market_data')).toEqual([
  {namespace:'market_data',key:'symbols',type:'json_array',exposure:'restricted',maximumCharacters:2048},
 ])
 const copy=settingValueRules();copy[0]!.key='modified';expect(settingValueRules()[0]!.key).not.toBe('modified')
})
it('rejects unknown, mismatched, service-owned and secret writes',()=>{
 for(const request of [{...input,key:'unknown'},{...input,expectedType:'string' as const},
  {namespace:'smtp',key:'pass',expectedType:'credential' as const,value:''},
  {namespace:'media_storage',key:'local_root',expectedType:'string' as const,value:'/tmp'},
  {namespace:'media_storage',key:'qiniu_connection_test_cleanup_pending',expectedType:'boolean' as const,value:'false'}])
  expect(validateSettingValueForWrite(request,()=>true)).toBe(false)
})
it('enforces exact integer boundaries, enum tokens, booleans and NULL policy',()=>{
 for(const value of ['1','65535']) expect(validateSettingValueForWrite({...input,value})).toBe(true)
 for(const value of [null,'0','65536','01','465\n',' 465','1e2','9007199254740993']) expect(validateSettingValueForWrite({...input,value})).toBe(false)
 expect(validateSettingValueForWrite({namespace:'auth_toggle',key:'gift_plan',expectedType:'enum',value:'admin'})).toBe(false)
 expect(validateSettingValueForWrite({namespace:'smtp',key:'secure',expectedType:'boolean',value:'true\n'})).toBe(false)
})
it('requires domain evidence for endpoints, addresses, rich content and storage readiness',()=>{
 for(const request of [
  {namespace:'smtp',key:'host',expectedType:'string' as const,value:'mail.example.com'},
  {namespace:'crypto_wallet',key:'fixed_tron_address',expectedType:'string' as const,value:'invalid'},
  {namespace:'market_menu',key:'items',expectedType:'json_array' as const,value:'[{}]'},
  {namespace:'changelog',key:'content',expectedType:'string' as const,value:'<script>x</script>'},
  {namespace:'media_storage',key:'default_provider',expectedType:'enum' as const,value:'qiniu'}]) {
   expect(inspectSettingUpdate(request)).toMatchObject({status:'eligible'})
   expect(validateSettingValueForWrite(request)).toBe(false)
   expect(validateSettingValueForWrite(request,()=>false)).toBe(false)
   expect(validateSettingValueForWrite(request,()=>true)).toBe(true)
 }
})
it('rejects invalid JSON and encoding and counts Unicode characters without normalization',()=>{
 expect(validateSettingValueForWrite({namespace:'toolbox',key:'items',expectedType:'json_array',value:'{}'},()=>true)).toBe(false)
 for(const value of ['x'.repeat(101),'\ud800']) expect(validateSettingValueForWrite({namespace:'smtp',key:'from_name',expectedType:'string',value},()=>true)).toBe(false)
 expect(validateSettingValueForWrite({namespace:'smtp',key:'from_name',expectedType:'string',value:'😀'.repeat(100)},()=>true)).toBe(true)
})
