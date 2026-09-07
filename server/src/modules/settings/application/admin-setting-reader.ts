import { settingValueRules,type SettingValueType } from '../domain/setting-value-policy.js'
export interface AdminSettingScope { namespace:string; key:string; expectedType:SettingValueType }
interface Metadata { id:string; namespace:string; key:string; type:SettingValueType; sensitivity:'public'|'restricted'|'secret'; revision:string }
export type AdminSettingLookup = {status:'missing'}
 | {status:'protected';metadata:Metadata;valueState:'null'|'empty'|'text'}
 | {status:'found';metadata:Metadata;valueState:'null'|'empty'|'text';rawValue:string|null}
export interface AdminSettingRepository { read(actorUserId:number,scope:AdminSettingScope):Promise<AdminSettingLookup> }
export class AdminSettingReader {
 constructor(private readonly repository:AdminSettingRepository) {}
 read(actor:{userId:number;role:string},input:{namespace:string;key:string}) {
  if(actor.role!=='admin') throw Error('setting_admin_required')
  if(!Number.isSafeInteger(actor.userId)||actor.userId<1||actor.userId>2147483647||!input
   ||Object.keys(input).sort().join(',')!=='key,namespace') throw Error('setting_read_request_invalid')
  const rule=settingValueRules().find(rule=>rule.namespace===input.namespace&&rule.key===input.key)
  if(!rule) throw Error('setting_read_request_invalid')
  return this.repository.read(actor.userId,{namespace:rule.namespace,key:rule.key,expectedType:rule.type})
 }
}
