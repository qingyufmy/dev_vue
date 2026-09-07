import { inspectSettingUpdate, type SettingValueInput } from '../domain/setting-value-policy.js'
export interface SettingChangeCommand extends SettingValueInput { actorUserId:number; requestId:string; expectedRevision:string }
export interface SettingChangeResult { id:string; revision:string; replayed:boolean }
export interface SettingManagementRepository { execute(command:SettingChangeCommand):Promise<SettingChangeResult> }
export function normalizeSettingCommand(input:SettingChangeCommand):SettingChangeCommand {
  if (!input || Object.keys(input).sort().join(',')!=='actorUserId,expectedRevision,expectedType,key,namespace,requestId,value'
    || !Number.isSafeInteger(input.actorUserId) || input.actorUserId<1 || input.actorUserId>2147483647
    || typeof input.requestId!=='string' || input.requestId.length!==36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)
    || typeof input.expectedRevision!=='string' || !/^[1-9][0-9]{0,19}$/.test(input.expectedRevision)
    || /[^0-9]/.test(input.expectedRevision) || BigInt(input.expectedRevision)>=18446744073709551615n)
    throw Error('setting_command_invalid')
  const command={...input}
  if (inspectSettingUpdate(command).status!=='eligible') throw Error('setting_command_policy_rejected')
  return command
}
export class SettingManagementService {
  constructor(private readonly repository:SettingManagementRepository) {}
  update(actor:{userId:number;role:string}, input:Omit<SettingChangeCommand,'actorUserId'>) {
    if (actor.role!=='admin') throw Error('setting_admin_required')
    return this.repository.execute(normalizeSettingCommand({...input,actorUserId:actor.userId}))
  }
}
