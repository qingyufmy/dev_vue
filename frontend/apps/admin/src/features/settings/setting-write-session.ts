import { ApiClientError,type createApiClient } from '@aurum/api-client'
import { settingRequestKeySchema,settingUpdateBodySchema,type SettingUpdateBody } from '@aurum/contracts'
type Client=Pick<ReturnType<typeof createApiClient>,'updateAdminSetting'>
const definiteRejections=new Set(['setting_admin_required','setting_command_invalid','setting_command_policy_rejected','setting_update_policy_rejected','setting_revision_conflict'])
type Phase='idle'|'submitting'|'uncertain'|'complete'|'rejected'
// One account-scoped in-memory operation. Never persist CSRF, session tokens or
// configuration text to browser storage. Page integration must retain this
// instance until resolution; navigation/reload recovery needs separate UX.
export function createSettingWriteSession(client:Client,actorId:string,newKey:()=>string=()=>crypto.randomUUID()) {
 let phase:Phase='idle'
 let pending:{body:SettingUpdateBody;requestKey:string}|null=null
 const snapshot=()=>({phase,pending:pending?structuredClone(pending):null})
 async function run(activeActorId:string,csrfToken:string,recovering:boolean) {
  if(activeActorId!==actorId||!activeActorId)throw Error('setting_actor_changed')
  if(!csrfToken)throw Error('setting_csrf_required')
  if(!pending||phase==='submitting')throw Error('setting_request_unavailable')
  phase='submitting'
  try {
   const result=await client.updateAdminSetting(pending.body,pending.requestKey,csrfToken)
   if(result.data.revision!==(BigInt(pending.body.expected_revision)+1n).toString())throw Error('setting_result_revision_invalid')
   phase='complete';pending=null
   return result
  } catch(error) {
   // A failed recovery does not disprove the earlier uncertain commit.
   if(!recovering&&error instanceof ApiClientError&&error.status>=400&&error.status<500
    &&error.problem?.status===error.status&&definiteRejections.has(error.problem.code)) {phase='rejected';pending=null}
   else phase='uncertain'
   throw error
  }
 }
 return {snapshot,
  async submit(activeActorId:string,body:SettingUpdateBody,csrfToken:string) {
   if(activeActorId!==actorId||!activeActorId)throw Error('setting_actor_changed')
   if(!csrfToken)throw Error('setting_csrf_required')
   if(pending)throw Error('setting_request_unresolved')
   const parsed=settingUpdateBodySchema.parse(body)
   pending={body:Object.freeze({...parsed}),requestKey:settingRequestKeySchema.parse(newKey())}
   return run(activeActorId,csrfToken,false)
  },
  async recover(activeActorId:string,csrfToken:string) {
   if(phase!=='uncertain')throw Error('setting_request_not_uncertain')
   return run(activeActorId,csrfToken,true)
  },
 }
}
