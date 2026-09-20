import {createHash} from 'node:crypto'
import type {Pool,RowDataPacket} from 'mysql2/promise'
import {InferenceError} from '../domain/inference-error.js'
export interface ModelAssignments {analysis:string|null;trader:string|null;review:string|null;revision:string}
export function createModelAssignments(pool:Pool){
 async function run(userId:number,change?:ModelAssignments,requestId?:string){
  const c=await pool.getConnection()
  try{
   await c.beginTransaction()
   const [users]=await c.execute<RowDataPacket[]>('SELECT id FROM users WHERE id=? FOR UPDATE',[userId])
   if(!users.length)throw new InferenceError('model_configuration_forbidden',403)
   const digest=createHash('sha256').update(JSON.stringify(['assignments',change])).digest('hex')
   if(change){const [prior]=await c.execute<RowDataPacket[]>('SELECT request_sha256,result_json FROM model_configuration_receipts_v4 WHERE actor_user_id=? AND request_id=?',[userId,requestId??'']);if(prior[0]){if(prior[0].request_sha256!==digest)throw new InferenceError('model_configuration_conflict',409);await c.commit();return typeof prior[0].result_json==='string'?JSON.parse(prior[0].result_json):prior[0].result_json}}
   const [rows]=await c.execute<RowDataPacket[]>('SELECT CAST(analysis_model_profile_id AS CHAR) analysis,CAST(trader_model_profile_id AS CHAR) trader,CAST(review_model_profile_id AS CHAR) review,CAST(revision AS CHAR) revision FROM user_model_assignments_v4 WHERE user_id=? FOR UPDATE',[userId])
   const state:ModelAssignments=rows[0]?{analysis:rows[0].analysis,trader:rows[0].trader,review:rows[0].review,revision:rows[0].revision}:{analysis:null,trader:null,review:null,revision:'0'}
   if(!change){await c.commit();return state}
   if(state.revision!==change.revision)throw new InferenceError('model_configuration_conflict',409)
   const ids=[...new Set([change.analysis,change.trader,change.review].filter((id):id is string=>id!==null))].sort((a,b)=>Number(a)-Number(b))
   for(const id of ids){
    const [models]=await c.execute<RowDataPacket[]>(`SELECT p.id FROM ai_model_profiles p JOIN ai_model_provider_capabilities cap ON cap.model_profile_id=p.id WHERE p.id=? AND p.deleted_at IS NULL AND p.status='active' AND ((p.scope='user' AND p.owner_user_id=?) OR (p.scope='platform' AND p.owner_user_id=0)) AND cap.verification_status='verified' AND cap.provider=p.provider AND cap.model_name=p.model_name AND cap.api_base_url=p.api_base_url FOR SHARE`,[id,userId])
    if(models.length!==1)throw new InferenceError('model_selection_unavailable',409)
   }
   const result={analysis:change.analysis,trader:change.trader,review:change.review,revision:String(BigInt(state.revision)+1n)}
   await c.execute(`INSERT INTO user_model_assignments_v4 (user_id,analysis_model_profile_id,trader_model_profile_id,review_model_profile_id,revision,updated_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE analysis_model_profile_id=VALUES(analysis_model_profile_id),trader_model_profile_id=VALUES(trader_model_profile_id),review_model_profile_id=VALUES(review_model_profile_id),revision=VALUES(revision),updated_at_utc=UTC_TIMESTAMP(3)`,[userId,result.analysis,result.trader,result.review,result.revision])
   await c.execute('INSERT INTO model_configuration_receipts_v4 (actor_user_id,request_id,model_profile_id,request_sha256,result_json,created_at_utc) VALUES (?,?,0,?,?,UTC_TIMESTAMP(3))',[userId,requestId??'',digest,JSON.stringify(result)])
   await c.commit();return result
  }catch(error){await c.rollback();throw error}finally{c.release()}
 }
 return {read:(userId:number)=>run(userId),save:(userId:number,requestId:string,change:ModelAssignments)=>run(userId,change,requestId)}
}
