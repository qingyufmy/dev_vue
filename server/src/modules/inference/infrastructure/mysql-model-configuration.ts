import {createModelAssignments} from './mysql-model-assignments.js'
import { modelThinkingOptions } from './model-thinking-options.js'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AdminPrincipalAccess } from '../../auth/index.js'
import type { ModelConfiguration, ModelConfigurationChange, ModelConfigurationService } from '../application/model-configuration.js'
import { InferenceError } from '../domain/inference-error.js'
import { loadCredentialKeyring, decryptCredential } from './mysql-model-gateway-resolver.js'
import { assertSafeEndpoint, boundedResponseText } from './http-json-model-gateway.js'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const select = `SELECT CAST(p.id AS CHAR) id,p.owner_user_id,p.scope,p.provider,p.model_name,p.api_base_url,p.api_key_encrypted,p.max_tokens,p.temperature,p.request_timeout_ms,p.thinking_enabled,p.reasoning_effort,c.context_window_tokens,c.max_input_tokens,c.max_output_tokens,
 p.status,CAST(p.updated_at AS CHAR) updated_at,c.protocol,c.verification_status,c.provider verified_provider,c.model_name verified_model,c.api_base_url verified_base
 FROM ai_model_profiles p LEFT JOIN ai_model_provider_capabilities c ON c.model_profile_id=p.id`
function view(row: RowDataPacket): ModelConfiguration {
  return { id: row.id, name: row.model_name, provider: row.provider, scope: row.scope, base_url: row.api_base_url ?? '',
    protocol: row.protocol === 'responses' ? 'responses' : 'chat_completions', max_tokens: row.max_output_tokens??null,
    temperature:row.temperature==null?null:Number(row.temperature),request_timeout_ms:row.request_timeout_ms??null,thinking_enabled:!!row.thinking_enabled,reasoning_effort:row.reasoning_effort??null,context_window_tokens:row.context_window_tokens??null,max_input_tokens:row.max_input_tokens??null,max_output_tokens:row.max_output_tokens??null,
    has_key: !!row.api_key_encrypted, verified: row.verification_status === 'verified' && row.model_name === row.verified_model
      && row.provider === row.verified_provider && row.api_base_url === row.verified_base,
    revision: hash([row.id,row.model_name,row.api_base_url,row.api_key_encrypted,row.max_tokens,row.protocol,row.updated_at,row.verification_status,row.temperature,row.request_timeout_ms,row.thinking_enabled,row.reasoning_effort,row.context_window_tokens,row.max_input_tokens,row.max_output_tokens]) }
}
export function createModelConfiguration(pool: Pool, admins: (connection: PoolConnection) => AdminPrincipalAccess): ModelConfigurationService {
  const assignments=createModelAssignments(pool)
  return {
    readAssignments:assignments.read,
    saveAssignments:assignments.save,
    async remove(userId,id,requestId,revision){
      const c=await pool.getConnection()
      try{
        await c.beginTransaction()
        const admin=await admins(c).isAdmin(userId,'share')
        const [rows]=await c.execute<RowDataPacket[]>(select+` WHERE p.id=? AND ((p.scope='user' AND p.owner_user_id=?) OR (?=1 AND p.scope='platform' AND p.owner_user_id=0)) FOR UPDATE`,[id,userId,admin?1:0])
        if(!rows[0])throw new InferenceError('model_configuration_forbidden',403)
        const digest=hash(['delete',id,revision])
        const [prior]=await c.execute<RowDataPacket[]>('SELECT request_sha256,result_json FROM model_configuration_receipts_v4 WHERE actor_user_id=? AND request_id=?',[userId,requestId])
        if(prior[0]){if(prior[0].request_sha256!==digest)throw new InferenceError('model_configuration_conflict',409);await c.commit();return typeof prior[0].result_json==='string'?JSON.parse(prior[0].result_json):prior[0].result_json}
        if(view(rows[0]).revision!==revision)throw new InferenceError('model_configuration_conflict',409)
        const [refs]=await c.execute<RowDataPacket[]>(`SELECT user_id FROM user_model_defaults WHERE model_profile_id=? UNION ALL SELECT user_id FROM user_model_assignments_v4 WHERE analysis_model_profile_id=? OR trader_model_profile_id=? OR review_model_profile_id=? LIMIT 1`,[id,id,id,id])
        if(refs.length)throw new InferenceError('model_configuration_in_use',409)
        await c.execute("UPDATE ai_model_profiles SET deleted_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3),status='inactive',is_default=0 WHERE id=?",[id])
        const result={id,deleted:true}
        await c.execute('INSERT INTO model_configuration_receipts_v4 (actor_user_id,request_id,model_profile_id,request_sha256,result_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',[userId,requestId,id,digest,JSON.stringify(result)])
        await c.commit();return result
      }catch(error){await c.rollback();throw error}finally{c.release()}
    },
    async verify(userId, id, requestId, revision) {
      const connection=await pool.getConnection()
      try {
        const admin=await admins(connection).isAdmin(userId,'none')
        const [rows]=await connection.execute<RowDataPacket[]>(select+` WHERE p.id=? AND p.deleted_at IS NULL AND ((p.scope='user' AND p.owner_user_id=?) OR (?=1 AND p.scope='platform' AND p.owner_user_id=0))`,[id,userId,admin ? 1 : 0])
        if (rows.length!==1) throw new InferenceError('model_configuration_forbidden',403)
        const digest=hash(['verify',id,revision])
        const [prior]=await connection.execute<RowDataPacket[]>('SELECT request_sha256,result_json FROM model_configuration_receipts_v4 WHERE actor_user_id=? AND request_id=?',[userId,requestId])
        if (prior[0]) {
          if (prior[0].request_sha256!==digest) throw new InferenceError('model_configuration_conflict',409)
          return typeof prior[0].result_json==='string' ? JSON.parse(prior[0].result_json) : prior[0].result_json
        }
        const row=rows[0]!
        if (view(row).revision!==revision) throw new InferenceError('model_configuration_conflict',409)
        try {
          const url=new URL(row.api_base_url)
          if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) throw Error('invalid')
          const responses=row.protocol==='responses', suffix=responses ? '/responses' : '/chat/completions'
          url.pathname=url.pathname.replace(/\/+$/, '')
          if(!url.pathname.endsWith(suffix)) url.pathname+=suffix
          await assertSafeEndpoint({endpoint:url.toString(),allowPrivateEndpoint:false})
          const messages=[{role:'user',content:'Reply with only a JSON object: {"ok":true}'}]
          const maxOutput=Number(row.max_output_tokens)
          if(!Number.isSafeInteger(maxOutput)||maxOutput<1||maxOutput>2147483647) throw Error('invalid output capacity')
          const body=responses ? {model:row.model_name,input:messages,max_output_tokens:maxOutput,text:{format:{type:'json_object'}}}
            : {model:row.model_name,messages,max_tokens:maxOutput,response_format:{type:'json_object'},stream:false}
          const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${decryptCredential(row.api_key_encrypted,loadCredentialKeyring())}`},body:JSON.stringify({...body,temperature:row.temperature==null?undefined:Number(row.temperature),...modelThinkingOptions(row.provider,responses?'responses':'chat_completions',!!row.thinking_enabled,row.reasoning_effort)})})
          if(!response.ok) throw Error('rejected')
          const data=JSON.parse(await boundedResponseText(response,131072))
          const text=responses ? data.output?.flatMap((item: any)=>item.content ?? []).filter((item: any)=>item.type==='output_text').map((item: any)=>item.text).join('') : data.choices?.[0]?.message?.content
          if(typeof text!=='string' || JSON.parse(text).ok!==true) throw Error('invalid')
        } catch { throw new InferenceError('model_configuration_probe_failed',422) }
        await connection.beginTransaction()
        const stillAdmin=await admins(connection).isAdmin(userId,'share')
        const [locked]=await connection.execute<RowDataPacket[]>(select+` WHERE p.id=? AND p.deleted_at IS NULL AND ((p.scope='user' AND p.owner_user_id=?) OR (?=1 AND p.scope='platform' AND p.owner_user_id=0)) FOR UPDATE`,[id,userId,stillAdmin ? 1 : 0])
        if(locked.length!==1) throw new InferenceError('model_configuration_forbidden',403)
        const [receipts]=await connection.execute<RowDataPacket[]>('SELECT request_sha256,result_json FROM model_configuration_receipts_v4 WHERE actor_user_id=? AND request_id=? FOR UPDATE',[userId,requestId])
        if(receipts[0]) {
          if(receipts[0].request_sha256!==digest) throw new InferenceError('model_configuration_conflict',409)
          await connection.commit()
          return typeof receipts[0].result_json==='string' ? JSON.parse(receipts[0].result_json) : receipts[0].result_json
        }
        if(view(locked[0]!).revision!==revision) throw new InferenceError('model_configuration_conflict',409)
        const clock=await capabilityClock(connection)
        await connection.execute(`INSERT INTO ai_model_provider_capabilities (model_profile_id,provider,model_name,api_base_url,protocol,supports_structured_output,verification_status,verified_by_user_id,${clock.verified},${clock.updated}) VALUES (?,?,?,?,?,1,'verified',?,${clock.now},${clock.now}) ON DUPLICATE KEY UPDATE provider=VALUES(provider),model_name=VALUES(model_name),api_base_url=VALUES(api_base_url),protocol=VALUES(protocol),supports_structured_output=1,verification_status='verified',verified_by_user_id=VALUES(verified_by_user_id),${clock.verified}=${clock.now},${clock.updated}=${clock.now}`,[id,row.provider,row.model_name,row.api_base_url,row.protocol==='responses'?'responses':'chat_completions',userId])
        await connection.execute("UPDATE ai_model_profiles SET status='active',updated_at=UTC_TIMESTAMP(3) WHERE id=?",[id])
        const [updated]=await connection.execute<RowDataPacket[]>(select+' WHERE p.id=?',[id]); const result=view(updated[0]!)
        await connection.execute('INSERT INTO model_configuration_receipts_v4 (actor_user_id,request_id,model_profile_id,request_sha256,result_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',[userId,requestId,id,digest,JSON.stringify(result)])
        await connection.commit(); return result
      } catch(error) { await connection.rollback(); throw error } finally { connection.release() }
    },
    async list(userId) {
      const connection = await pool.getConnection()
      try {
        const admin = await admins(connection).isAdmin(userId, 'none')
        const [rows] = await connection.execute<RowDataPacket[]>(select + ` WHERE p.deleted_at IS NULL AND ((p.scope='user' AND p.owner_user_id=?) OR (?=1 AND p.scope='platform' AND p.owner_user_id=0)) ORDER BY p.id LIMIT 100`, [userId,admin ? 1 : 0])
        return rows.map(view)
      } finally { connection.release() }
    },
    async save(userId, id, requestId, change) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const admin = await admins(connection).isAdmin(userId, 'share')
        const creating=id==='new'
        const digest=hash([id,change])
        if(creating){
          if(!change.provider || !change.scope || change.scope==='platform'&&!admin)throw new InferenceError('model_configuration_forbidden',403)
          const [actors]=await connection.execute<RowDataPacket[]>('SELECT id FROM users WHERE id=? FOR UPDATE',[userId])
          if(!actors.length)throw new InferenceError('model_configuration_forbidden',403)
          const [prior]=await connection.execute<RowDataPacket[]>('SELECT request_sha256,result_json FROM model_configuration_receipts_v4 WHERE actor_user_id=? AND request_id=?',[userId,requestId])
          if(prior[0]){if(prior[0].request_sha256!==digest)throw new InferenceError('model_configuration_conflict',409);await connection.commit();return typeof prior[0].result_json==='string'?JSON.parse(prior[0].result_json):prior[0].result_json}
          const [inserted]=await connection.execute<import('mysql2/promise').ResultSetHeader>("INSERT INTO ai_model_profiles (owner_user_id,scope,provider,model_name,status,created_at,updated_at) VALUES (?,?,?,'','inactive',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[change.scope==='platform'?0:userId,change.scope,change.provider])
          id=String(inserted.insertId)
        }
        const [rows] = await connection.execute<RowDataPacket[]>(select + ` WHERE p.id=? AND p.deleted_at IS NULL AND ((p.scope='user' AND p.owner_user_id=?) OR (?=1 AND p.scope='platform' AND p.owner_user_id=0)) FOR UPDATE`, [id,userId,admin ? 1 : 0])
        if (rows.length !== 1) throw new InferenceError('model_configuration_forbidden',403)
        const row=rows[0]!
        const [receipts] = await connection.execute<RowDataPacket[]>('SELECT request_sha256,result_json FROM model_configuration_receipts_v4 WHERE actor_user_id=? AND request_id=? FOR UPDATE',[userId,requestId])
        if (receipts[0]) {
          if (receipts[0].request_sha256 !== digest) throw new InferenceError('model_configuration_conflict',409)
          await connection.commit()
          return typeof receipts[0].result_json === 'string' ? JSON.parse(receipts[0].result_json) : receipts[0].result_json
        }
        if (!creating && view(row).revision !== change.expected_revision) throw new InferenceError('model_configuration_conflict',409)
        let url: URL
        try { url=new URL(change.base_url) } catch { throw new InferenceError('model_configuration_invalid',422) }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new InferenceError('model_configuration_invalid',422)
        const base=url.toString().replace(/\/+$/, '')
        if (base !== String(row.api_base_url ?? '').replace(/\/+$/, '') && !change.api_key) throw new InferenceError('model_configuration_new_key_required',422)
        let encrypted=row.api_key_encrypted, keyVersion: string | null=null
        if (change.api_key) {
          const keys=loadCredentialKeyring(), entry=keys.entries().next().value
          if (!entry) throw new InferenceError('model_configuration_unavailable',503)
          const [version,key]=entry, iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv)
          encrypted=JSON.stringify({v:version,iv:iv.toString('base64'),ct:Buffer.concat([cipher.update(change.api_key,'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')})
          keyVersion=version
        }
        if (!encrypted) throw new InferenceError('model_configuration_new_key_required',422)
        const value={...view(row),...change}
        if(value.max_input_tokens && value.context_window_tokens && value.max_input_tokens>value.context_window_tokens) throw new InferenceError('model_configuration_invalid',422)
        if(!Number.isSafeInteger(value.max_output_tokens)||!value.max_output_tokens||value.max_output_tokens<1) throw new InferenceError('model_configuration_invalid',422)
        const changed=row.model_name!==change.name || base!==row.api_base_url || !!change.api_key || row.protocol!==change.protocol || value.thinking_enabled!==!!row.thinking_enabled || value.reasoning_effort!==(row.reasoning_effort??null)
        await connection.execute('UPDATE ai_model_profiles SET model_name=?,api_base_url=?,api_key_encrypted=?,key_version=COALESCE(?,key_version),updated_at=UTC_TIMESTAMP(3) WHERE id=?', [change.name,base,encrypted,keyVersion,id])
        if (changed) {
          const clock=await capabilityClock(connection)
          await connection.execute(`INSERT INTO ai_model_provider_capabilities (model_profile_id,provider,model_name,api_base_url,protocol,supports_structured_output,verification_status,${clock.updated})
          VALUES (?,?,?,?,?,0,'unverified',${clock.now}) ON DUPLICATE KEY UPDATE provider=VALUES(provider),model_name=VALUES(model_name),api_base_url=VALUES(api_base_url),protocol=VALUES(protocol),supports_structured_output=0,verification_status='unverified',verified_by_user_id=NULL,${clock.verified}=NULL,${clock.updated}=${clock.now}`, [id,row.provider,change.name,base,change.protocol])
        }
        await connection.execute('UPDATE ai_model_profiles SET temperature=?,request_timeout_ms=?,thinking_enabled=?,reasoning_effort=? WHERE id=?',[value.temperature??null,value.request_timeout_ms??null,value.thinking_enabled?1:0,value.thinking_enabled?value.reasoning_effort??null:null,id])
        if(change.context_window_tokens!==undefined || change.max_input_tokens!==undefined || change.max_output_tokens!==undefined) await connection.execute('UPDATE ai_model_provider_capabilities SET context_window_tokens=?,max_input_tokens=?,max_output_tokens=? WHERE model_profile_id=?',[value.context_window_tokens??null,value.max_input_tokens??null,value.max_output_tokens??null,id])
        const [updated]=await connection.execute<RowDataPacket[]>(select+' WHERE p.id=?',[id])
        const result=view(updated[0]!)
        await connection.execute('INSERT INTO model_configuration_receipts_v4 (actor_user_id,request_id,model_profile_id,request_sha256,result_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',[userId,requestId,id,digest,JSON.stringify(result)])
        await connection.commit()
        return result
      } catch(error) { await connection.rollback(); throw error } finally { connection.release() }
    },
  }
}

// Both foundation installs and upgraded databases are supported. Identifiers
// below are fixed literals, never supplied by the browser.
async function capabilityClock(connection: PoolConnection) {
 const [columns]=await connection.execute<RowDataPacket[]>("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_model_provider_capabilities' AND COLUMN_NAME IN ('verified_at_utc','updated_at_utc','verified_at_utc_msc','updated_at_utc_msc')")
 const names=new Set(columns.map(row=>String(row.COLUMN_NAME)))
 if(names.has('verified_at_utc_msc')&&names.has('updated_at_utc_msc'))return {verified:'verified_at_utc_msc',updated:'updated_at_utc_msc',now:'CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED)'}
 if(names.has('verified_at_utc')&&names.has('updated_at_utc'))return {verified:'verified_at_utc',updated:'updated_at_utc',now:'UTC_TIMESTAMP(3)'}
 throw new InferenceError('model_configuration_schema_unavailable',503)
}
