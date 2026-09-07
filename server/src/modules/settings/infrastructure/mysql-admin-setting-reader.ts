import type { Pool,RowDataPacket } from 'mysql2/promise'
import type { AdminSettingRepository,AdminSettingScope } from '../application/admin-setting-reader.js'
import { readSetting } from './mysql-setting-reader.js'
export class MysqlAdminSettingReader implements AdminSettingRepository {
 constructor(private readonly pool:Pick<Pool,'getConnection'>) {}
 async read(actorUserId:number,scope:AdminSettingScope) {
  if(!Number.isSafeInteger(actorUserId)||actorUserId<1||actorUserId>2147483647) throw Error('setting_read_request_invalid')
  const connection=await this.pool.getConnection()
  let started=false,destroyed=false
  try {
   await connection.query("SET SESSION time_zone='+00:00'")
   await connection.beginTransaction();started=true
   // Keep deletion/role changes fenced through the read; no config writes.
   const [actors]=await connection.execute<RowDataPacket[]>(
    "SELECT id FROM users WHERE id=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL FOR SHARE",[actorUserId])
   if(actors.length!==1) throw Error('setting_admin_required')
   const result=await readSetting(connection,scope)
   await connection.rollback();started=false
   return result
  } catch(error) {
   if(started) {try {await connection.rollback()}catch {connection.destroy();destroyed=true}}
   throw error
  } finally {if(!destroyed)connection.release()}
 }
}
