import { createHash } from 'node:crypto'
import type { Pool,RowDataPacket } from 'mysql2/promise'
import { normalizeSettingCommand,type SettingChangeCommand,type SettingChangeResult,type SettingManagementRepository } from '../application/setting-management.js'
import { validateSettingValueForWrite,type SettingPolicyCheck,type SettingValueInput } from '../domain/setting-value-policy.js'
import { updateSettingInTransaction } from './mysql-setting-writer.js'
interface Receipt extends RowDataPacket { request_sha256:string; setting_id:string; revision:string; actor_user_id:string; request_id:string }
export function settingRequestHash(command:SettingChangeCommand):string {
  // Versioned ordered array: no value trimming, object-key ordering or implicit defaults.
  return createHash('sha256').update(JSON.stringify(['setting-update/v1',command.actorUserId,command.requestId,
    command.namespace,command.key,command.expectedType,command.expectedRevision,command.value])).digest('hex')
}
export class MysqlSettingManagement implements SettingManagementRepository {
  constructor(private readonly pool:Pick<Pool,'getConnection'>,
    private readonly validateDomain?:(check:SettingPolicyCheck,input:Readonly<SettingValueInput>)=>boolean) {}
  async execute(input:SettingChangeCommand):Promise<SettingChangeResult> {
    const command=normalizeSettingCommand(input)
    const requestHash=settingRequestHash(command)
    const connection=await this.pool.getConnection()
    let started=false,commitAttempted=false,destroyed=false
    try {
      await connection.query("SET SESSION time_zone='+00:00'")
      await connection.beginTransaction();started=true
      // Lock order: actor, receipt, setting. Replays reauthorize before lookup.
      const [actors]=await connection.execute<RowDataPacket[]>(
        "SELECT id FROM users WHERE id=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE",[command.actorUserId])
      if(actors.length!==1) throw Error('setting_admin_required')
      const [receipts]=await connection.execute<Receipt[]>(`SELECT r.request_sha256,CAST(r.setting_id AS CHAR) setting_id,
        CAST(r.revision AS CHAR) revision,CAST(a.actor_user_id AS CHAR) actor_user_id,a.request_id
        FROM system_setting_requests r JOIN system_setting_changes a ON a.setting_id=r.setting_id AND a.revision=r.revision
        WHERE r.actor_user_id=? AND r.request_id=? FOR UPDATE`,[command.actorUserId,command.requestId])
      let result:SettingChangeResult
      if(receipts.length) {
        const receipt=receipts[0]!
        if(receipts.length!==1 || receipt.request_sha256!==requestHash || receipt.actor_user_id!==String(command.actorUserId)
          || receipt.request_id!==command.requestId || receipt.revision!==(BigInt(command.expectedRevision)+1n).toString()
          || !/^[1-9][0-9]{0,9}$/.test(receipt.setting_id) || /[^0-9]/.test(receipt.setting_id)
          || BigInt(receipt.setting_id)>2147483647n) throw Error('setting_idempotency_conflict')
        result={id:receipt.setting_id,revision:receipt.revision,replayed:true}
      } else {
        // Credential inputs have already been rejected by normalization.
        const updated=await updateSettingInTransaction(connection,{...command,expectedType:command.expectedType as Exclude<typeof command.expectedType,'credential'>},
          value=>validateSettingValueForWrite(value,this.validateDomain))
        await connection.execute(`INSERT INTO system_setting_requests
          (actor_user_id,request_id,request_sha256,setting_id,revision,recorded_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
          [command.actorUserId,command.requestId,requestHash,updated.id,updated.revision])
        result={...updated,replayed:false}
      }
      commitAttempted=true;await connection.commit()
      return result
    } catch(error) {
      if(commitAttempted) {connection.destroy();destroyed=true;throw Error('setting_commit_unknown')}
      if(started) {try {await connection.rollback()} catch {connection.destroy();destroyed=true;throw Error('setting_rollback_unknown')}}
      throw error
    } finally {if(!destroyed) connection.release()}
  }
}
