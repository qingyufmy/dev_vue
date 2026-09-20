import { expect,it,vi,afterEach } from 'vitest'
import type {Pool} from 'mysql2/promise'
import {createModelConfiguration} from '../src/modules/inference/infrastructure/mysql-model-configuration.js'
import * as gateway from '../src/modules/inference/infrastructure/http-json-model-gateway.js'
import {decryptCredential} from '../src/modules/inference/infrastructure/mysql-model-gateway-resolver.js'
const encryptionKey=Buffer.alloc(32,7)
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks()})
function setup(allowed=true, milliseconds=true,inUse=false){
 let row:any={id:'3',owner_user_id:7,scope:'user',provider:'compatible',model_name:'old',api_base_url:'https://example.com/v1',api_key_encrypted:'old-encrypted',max_tokens:1000,max_output_tokens:393216,status:'active',updated_at:'before',protocol:'chat_completions',verification_status:'verified',verified_provider:'compatible',verified_model:'old',verified_base:'https://example.com/v1'}
 const receipts:any[]=[];const writes:any[]=[]
 const connection={beginTransaction:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn(),execute:vi.fn(async(sql:string,args:any[])=>{
  if(sql.startsWith('SELECT id FROM users'))return [[{id:7}],[]]
  if(sql.startsWith('SELECT user_id FROM user_model_defaults'))return [inUse?[{user_id:7}]:[],[]]
  if(sql.startsWith('INSERT INTO ai_model_profiles')){row={...row,id:'8',model_name:'',api_key_encrypted:null};writes.push({sql,args});return [{insertId:8,affectedRows:1},[]]}
  if(sql.startsWith('SELECT COLUMN_NAME'))return [[{COLUMN_NAME:milliseconds?'verified_at_utc_msc':'verified_at_utc'},{COLUMN_NAME:milliseconds?'updated_at_utc_msc':'updated_at_utc'}],[]]
  if(sql.startsWith('SELECT CAST(p.id')) {expect(sql).toContain('p.id'); if(sql.includes('owner_user_id=?')){expect(args).toContain(7);expect(args.at(-1)).toBe(0)} return [allowed?[{...row}]:[],[]]}
  if(sql.startsWith('SELECT request_sha256'))return [receipts.filter(item=>item.request_id===args[1]),[]]
  writes.push({sql,args})
  if(sql.startsWith('UPDATE ai_model_profiles SET temperature'))row={...row,temperature:args[0],request_timeout_ms:args[1],thinking_enabled:args[2],reasoning_effort:args[3]}
  if(sql.startsWith('UPDATE ai_model_provider_capabilities SET context_window_tokens'))row={...row,context_window_tokens:args[0],max_input_tokens:args[1],max_output_tokens:args[2]}
  if(sql.startsWith('UPDATE ai_model_profiles SET model_name'))row={...row,model_name:args[0],api_base_url:args[1],api_key_encrypted:args[2],updated_at:'after'}
  if(sql.startsWith('INSERT INTO ai_model_provider_capabilities')){row.verification_status=sql.includes("1,'verified'")?'verified':'unverified';row.verified_model=row.model_name;row.verified_provider=row.provider;row.verified_base=row.api_base_url}
  if(sql.startsWith('INSERT INTO model_configuration_receipts'))receipts.push({request_id:args[1],request_sha256:args[3],result_json:JSON.parse(args[4])})
  return [{affectedRows:1},[]]
 })}
 const service=createModelConfiguration({getConnection:async()=>connection} as unknown as Pool,()=>({isAdmin:async()=>false}))
 return {service,writes,connection,getRow:()=>row}
}
it.each([true,false])('preserves keys and replays saves for timestamp schema %s',async(milliseconds)=>{
 const {service,writes}=setup(true,milliseconds);const current=(await service.list(7))[0]!
 const change={name:'new',base_url:current.base_url,protocol:current.protocol,max_tokens:2000,expected_revision:current.revision}
 const result=await service.save(7,'3','request-123456789',change)
 expect(result.name).toBe('new');expect(result.verified).toBe(false);expect(JSON.stringify(result)).not.toContain('old-encrypted')
 expect(writes[0].args[2]).toBe('old-encrypted')
 const capabilityWrite=writes.find(item=>item.sql.startsWith('INSERT INTO ai_model_provider_capabilities'))
 expect(capabilityWrite.sql).toContain(milliseconds?'updated_at_utc_msc':'updated_at_utc')
 expect(capabilityWrite.sql).toContain(milliseconds?'UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))':'UTC_TIMESTAMP(3)')
 const count=writes.length;expect(await service.save(7,'3','request-123456789',change)).toEqual(result);expect(writes).toHaveLength(count)
})
it('encrypts replacement credentials and requires them when changing endpoint',async()=>{
 vi.stubEnv('AI_CREDENTIAL_KEYS_JSON',JSON.stringify({v1:encryptionKey.toString('base64')}))
 const {service,getRow}=setup();const current=(await service.list(7))[0]!
 const change={name:'new',base_url:'https://other.example/v1',protocol:current.protocol,max_tokens:2000,expected_revision:current.revision}
 await expect(service.save(7,'3','request-123456789',change)).rejects.toMatchObject({code:'model_configuration_new_key_required'})
 await service.save(7,'3','request-123456789',{...change,api_key:'new-secret'})
 expect(getRow().api_key_encrypted).not.toContain('new-secret')
 expect(decryptCredential(getRow().api_key_encrypted,new Map([['v1',encryptionKey]]))).toBe('new-secret')
})
it('rejects stale edits and unauthorized profiles before writing',async()=>{
 const denied=setup(false);await expect(denied.service.save(7,'3','request-123456789',{} as any)).rejects.toMatchObject({status:403});expect(denied.writes).toHaveLength(0)
 const stale=setup();await expect(stale.service.save(7,'3','request-123456789',{expected_revision:'bad'} as any)).rejects.toMatchObject({code:'model_configuration_conflict'});expect(stale.writes).toHaveLength(0)
})

it.each([true,false])('marks a configuration verified only after valid provider output: %s',async(valid)=>{
 vi.stubEnv('AI_CREDENTIAL_KEYS_JSON',JSON.stringify({v1:encryptionKey.toString('base64')}))
 vi.spyOn(gateway,'assertSafeEndpoint').mockResolvedValue(undefined)
 const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:valid?'{"ok":true}':'not JSON'}}]}),{status:200}))
 vi.stubGlobal('fetch',request)
 const {service,writes}=setup();const old=(await service.list(7))[0]!
 const saved=await service.save(7,'3','save-123456789',{name:'new',base_url:old.base_url,protocol:old.protocol,max_tokens:2000,expected_revision:old.revision,api_key:'test-secret'})
 const count=writes.length
 if(valid){const result=await service.verify(7,'3','verify-123456789',saved.revision);expect(result.verified).toBe(true);expect(await service.verify(7,'3','verify-123456789',saved.revision)).toEqual(result);expect(request).toHaveBeenCalledTimes(1)}
 else{await expect(service.verify(7,'3','verify-123456789',saved.revision)).rejects.toMatchObject({code:'model_configuration_probe_failed'});expect(writes).toHaveLength(count)}
 expect(request.mock.calls[0]![1].redirect).toBe('error')
 expect(JSON.parse(request.mock.calls[0]![1].body).max_tokens).toBe(393216)
})

it('persists and returns capability edits and ignores the obsolete output budget',async()=>{
 const {service}=setup();const before=(await service.list(7))[0]!
 const change={name:before.name,base_url:before.base_url,protocol:before.protocol,max_tokens:30000,expected_revision:before.revision,temperature:0.3,request_timeout_ms:180000,thinking_enabled:true,reasoning_effort:'high' as const,context_window_tokens:1048576,max_input_tokens:1048576,max_output_tokens:393216}
 const result=await service.save(7,'3','capability-save-123',change)
 expect(result).toMatchObject({temperature:0.3,request_timeout_ms:180000,thinking_enabled:true,reasoning_effort:'high',context_window_tokens:1048576,max_input_tokens:1048576,max_output_tokens:393216})
 const again=await service.save(7,'3','capability-save-456',{...change,expected_revision:result.revision,max_tokens:400000});expect(again.max_tokens).toBe(393216)
})

it('creates a private profile once and rejects unauthorized shared creation',async()=>{
 vi.stubEnv('AI_CREDENTIAL_KEYS_JSON',JSON.stringify({v1:encryptionKey.toString('base64')}))
 const {service,writes}=setup();const change={name:'new',provider:'deepseek' as const,scope:'user' as const,base_url:'https://example.com/v1',protocol:'chat_completions' as const,api_key:'synthetic-secret',max_output_tokens:393216,expected_revision:''}
 const result=await service.save(7,'new','create-request-123',change);expect(result.id).toBe('8');expect(result.verified).toBe(false)
 const count=writes.length;expect(await service.save(7,'new','create-request-123',change)).toEqual(result);expect(writes).toHaveLength(count)
 await expect(service.save(7,'new','create-request-456',{...change,scope:'platform'})).rejects.toMatchObject({status:403})
})
it('soft deletes unused models, replays receipts and refuses referenced models',async()=>{
 const f=setup();const before=(await f.service.list(7))[0]!
 expect(await f.service.remove(7,'3','delete-request-123',before.revision)).toEqual({id:'3',deleted:true})
 expect(f.writes.some(w=>w.sql.includes('SET deleted_at='))).toBe(true)
 const count=f.writes.length;await f.service.remove(7,'3','delete-request-123',before.revision);expect(f.writes).toHaveLength(count)
 const used=setup(true,true,true);const current=(await used.service.list(7))[0]!
 await expect(used.service.remove(7,'3','delete-request-456',current.revision)).rejects.toMatchObject({code:'model_configuration_in_use'})
 expect(used.writes).toHaveLength(0)
})
