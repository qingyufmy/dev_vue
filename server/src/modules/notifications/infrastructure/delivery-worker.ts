import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { defaultPreferences, shouldNotify, type DeliveryScope } from '../application/notifications.js'
import { unseal } from './notification-secrets.js'
const require = createRequire(import.meta.url)
const parse=(v:unknown): Record<string,unknown> => typeof v === 'string' ? JSON.parse(v) : v as Record<string,unknown>
export function createNotificationDeliveryWorker(pool:Pool) {
 return { async runBatch() {
  const [rows]=await pool.execute<RowDataPacket[]>(`SELECT d.user_id,d.message_id,d.channel,n.title,n.summary,n.kind,n.actionable,p.preferences_json,u.email
    FROM notification_deliveries_v4 d JOIN user_notifications_v4 n ON n.id=d.message_id AND n.user_id=d.user_id
    JOIN user_notification_preferences_v4 p ON p.user_id=d.user_id JOIN users u ON u.id=d.user_id AND u.deleted_at IS NULL AND u.deletion_status='active'
    WHERE d.status='pending' ORDER BY d.created_at_utc LIMIT 20`)
  for(const row of rows){
    const [claimed]=await pool.execute<ResultSetHeader>("UPDATE notification_deliveries_v4 SET status='sending' WHERE user_id=? AND message_id=? AND channel=? AND status='pending'",[row.user_id,row.message_id,row.channel])
    if(!claimed.affectedRows)continue
    let status='failed'
    try {
      const prefs=parse(row.preferences_json), text=`${row.title}\n${row.summary}`
      const kind = row.kind === 'analysis' ? 'analysis' : row.kind === 'decision' ? 'decision' : null
      const allowed = kind && shouldNotify((prefs[kind] ?? defaultPreferences[kind]) as DeliveryScope, Number(row.actionable) === 1)
      if (!allowed) status='cancelled'
      else if(row.channel==='feishu' && prefs.feishuEnabled){
        const hook=unseal(String(prefs.feishuWebhook)), url=new URL(hook)
        if(url.origin!=='https://open.feishu.cn'||!url.pathname.startsWith('/open-apis/bot/v2/hook/'))throw Error('channel_invalid')
        const timestamp=String(Math.floor(Date.now()/1000)),secret=prefs.feishuSecret?unseal(String(prefs.feishuSecret)):''
        const body={msg_type:'text',content:{text},...(secret?{timestamp,sign:createHmac('sha256',`${timestamp}\n${secret}`).update('').digest('base64')}:{})}
        status='uncertain'
        const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)})
        const result=await response.json() as {code?:number;StatusCode?:number}
        status=response.ok && (result.code===0||result.StatusCode===0)?'sent':'failed'
      }else if(row.channel==='email' && prefs.emailEnabled){
        if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!row.email)throw Error('mail_unconfigured')
        const mail=require('nodemailer').createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT??587),secure:process.env.SMTP_PORT==='465',requireTLS:true,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},connectionTimeout:10000,socketTimeout:15000})
        status='uncertain'
        try {await mail.sendMail({from:process.env.SMTP_FROM??process.env.SMTP_USER,to:row.email,subject:row.title,text});status='sent'} finally {mail.close()}
      }else status='cancelled'
    }catch { /* Never replay an ambiguous external send. Persist its outcome for review. */ }
    await pool.execute("UPDATE notification_deliveries_v4 SET status=?,completed_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND message_id=? AND channel=? AND status='sending'",[status,row.user_id,row.message_id,row.channel])
  }
  return rows.length
 } }
}
