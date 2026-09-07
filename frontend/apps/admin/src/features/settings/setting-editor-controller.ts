import { ApiClientError,type createApiClient } from '@aurum/api-client'
import { createSettingWriteSession } from './setting-write-session'
type Client=Pick<ReturnType<typeof createApiClient>,'getAdminSetting'|'updateAdminSetting'>
type Scope={namespace:string;key:string}
type Value=Awaited<ReturnType<Client['getAdminSetting']>>['data']
export function createSettingEditorController(client:Client,actorId:string,newKey?:()=>string) {
 const writes=createSettingWriteSession(client,actorId,newKey)
 let generation=0,loading=false,scope:Scope|null=null,current:Value|null=null,error:string|null=null
 const assertActor=(active:string)=>{if(active!==actorId||!active)throw Error('setting_actor_changed')}
 const snapshot=()=>({loading,scope:scope?{...scope}:null,current:current?structuredClone(current):null,error,write:writes.snapshot()})
 async function load(active:string,next:Scope) {
  assertActor(active)
  if(writes.snapshot().pending)throw Error('setting_request_unresolved')
  const request=++generation;scope={...next};current=null;loading=true;error=null
  try {
   const response=await client.getAdminSetting({...next})
   if(request!==generation)return false
   if(response.data.namespace!==next.namespace||response.data.key!==next.key)throw Error('setting_response_scope_mismatch')
   current=structuredClone(response.data)
   return true
  } catch(failure) {
   if(request!==generation)return false
   error=failure instanceof ApiClientError&&failure.status===404?'setting_missing':'setting_read_unavailable'
   return false
  } finally {if(request===generation)loading=false}
 }
 async function refreshAfterWrite(active:string) {
  // The receipt is authoritative for the write. Refresh failure must not turn
  // a committed write back into an uncertain operation or retain an old form.
  current=null
  if(scope)await load(active,scope)
 }
 return {snapshot,load,
  async save(active:string,value:string,csrf:string) {
   assertActor(active)
   if(loading||!current||current.protected)throw Error('setting_not_editable')
   const previous=current
   const promise=writes.submit(active,{namespace:previous.namespace,key:previous.key,value_type:previous.value_type,
    expected_revision:previous.revision,value},csrf)
   // Fence any older load immediately; the pending write retains its scope.
   const operation=++generation
   const result=await promise
   if(generation===operation)await refreshAfterWrite(active)
   return result
  },
  async recover(active:string,csrf:string) {
   assertActor(active)
   const operation=generation
   const result=await writes.recover(active,csrf)
   if(generation===operation)await refreshAfterWrite(active)
   return result
  },
  suspend() {generation++;loading=false;scope=null;current=null;error=null},
 }
}
