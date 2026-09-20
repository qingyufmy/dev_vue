import type { Pool, RowDataPacket } from 'mysql2/promise'
import { defaultPreferences, shouldNotify, type NotificationPreferences } from '../application/notifications.js'
interface Source {userId:number;resourceId:string;kind:'analysis'|'decision';title:string;summary:string;actionable:boolean;createdAt:Date}
export function createNotificationPublisher(pool:Pool, read:(kind:'analysis'|'decision',id:string)=>Promise<Source|null>) {
  return { async publish(event:{eventType:string;payload:Record<string,unknown>}) {
    const kind = event.eventType === 'market_analysis.created' ? 'analysis' : event.eventType === 'trade_decision.created' ? 'decision' : null
    if (!kind) return
    const id=String(event.payload[kind === 'analysis' ? 'market_analysis_id' : 'decision_id'] ?? '')
    const source=await read(kind,id)
    if (!source) return
    const db=await pool.getConnection()
    try {
      await db.beginTransaction()
      const [rows]=await db.execute<RowDataPacket[]>('SELECT preferences_json FROM user_notification_preferences_v4 WHERE user_id=?',[source.userId])
      const saved=rows[0]?.preferences_json, preferences:NotificationPreferences=saved ? typeof saved === 'string' ? JSON.parse(saved) : saved : defaultPreferences
      if (!shouldNotify(preferences[kind],source.actionable)) {await db.commit();return}
      const messageId=`${kind}:${id}`
      await db.execute(`INSERT IGNORE INTO user_notifications_v4 (id,user_id,kind,resource_id,title,summary,actionable,created_at_utc) VALUES (?,?,?,?,?,?,?,?)`,[messageId,source.userId,kind,id,source.title,source.summary,source.actionable?1:0,source.createdAt])
      for (const channel of ['feishu','email'] as const) {
        if (!preferences[channel === 'feishu' ? 'feishuEnabled' : 'emailEnabled']) continue
        await db.execute(`INSERT IGNORE INTO notification_deliveries_v4 (user_id,message_id,channel,status,created_at_utc) VALUES (?,?,?,'pending',UTC_TIMESTAMP(3))`,[source.userId,messageId,channel])
      }
      await db.commit()
    } catch(error) {await db.rollback();throw error} finally {db.release()}
  } }
}
