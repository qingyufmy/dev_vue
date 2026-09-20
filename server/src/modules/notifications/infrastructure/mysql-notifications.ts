import { createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { defaultPreferences, NotificationError, type NotificationPreferences } from '../application/notifications.js'
import { seal } from './notification-secrets.js'
const parse = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
export function createNotificationSettings(pool: Pool) {
  return {
    async read(userId: number) {
      const [rows] = await pool.execute<RowDataPacket[]>('SELECT nickname,preferences_json,revision FROM user_notification_preferences_v4 WHERE user_id=?', [userId])
      const row = rows[0], stored = parse(row?.preferences_json) ?? {}
      return { nickname: row?.nickname ?? '', preferences: Object.fromEntries(Object.entries(defaultPreferences).map(([key, value]) => [key, stored[key] ?? value])), hasFeishu: !!stored.feishuWebhook, emailAvailable: !!(process.env.SMTP_HOST && process.env.SMTP_USER), revision: Number(row?.revision ?? 0) }
    },
    async save(userId: number, input: { nickname: string; preferences: NotificationPreferences; revision: number; feishuWebhook?: string; feishuSecret?: string }, key: string) {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) throw new NotificationError('notification_request_invalid',400)
      if (input.preferences.emailEnabled && !(process.env.SMTP_HOST && process.env.SMTP_USER)) throw new NotificationError('notification_email_unconfigured',422)
      if (input.feishuWebhook) {
        let url: URL
        try { url = new URL(input.feishuWebhook) } catch { throw new NotificationError('notification_channel_invalid',422) }
        if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || url.port || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new NotificationError('notification_channel_invalid',422)
      }
      const db = await pool.getConnection(), hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      try {
        await db.beginTransaction()
        const [identity] = await db.execute<RowDataPacket[]>("SELECT id FROM users WHERE id=? AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [userId])
        if (!identity.length) throw new NotificationError('notification_forbidden',403)
        const [receipts] = await db.execute<RowDataPacket[]>('SELECT request_hash,response_json FROM notification_settings_receipts_v4 WHERE user_id=? AND request_key=?', [userId,key])
        if (receipts[0]) {
          if (receipts[0].request_hash !== hash) throw new NotificationError('notification_request_conflict',409)
          await db.commit(); return parse(receipts[0].response_json)
        }
        const [rows] = await db.execute<RowDataPacket[]>('SELECT preferences_json,revision FROM user_notification_preferences_v4 WHERE user_id=? FOR UPDATE', [userId])
        if (Number(rows[0]?.revision ?? 0) !== input.revision) throw new NotificationError('notification_revision_conflict',409)
        const previous = parse(rows[0]?.preferences_json) ?? {}, preferences = { ...input.preferences,
          feishuWebhook: input.feishuWebhook ? seal(input.feishuWebhook) : previous.feishuWebhook,
          feishuSecret: input.feishuSecret ? seal(input.feishuSecret) : previous.feishuSecret }
        if (preferences.feishuEnabled && !preferences.feishuWebhook) throw new NotificationError('notification_channel_missing',422)
        const revision = input.revision + 1
        await db.execute(`INSERT INTO user_notification_preferences_v4 (user_id,nickname,preferences_json,revision,updated_at_utc,created_at_utc)
          VALUES (?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE nickname=VALUES(nickname),preferences_json=VALUES(preferences_json),revision=VALUES(revision),updated_at_utc=UTC_TIMESTAMP(3)`, [userId,input.nickname,JSON.stringify(preferences),revision])
        const result = { revision }
        await db.execute('INSERT INTO notification_settings_receipts_v4 (user_id,request_key,request_hash,response_json,created_at_utc) VALUES (?,?,?,?,UTC_TIMESTAMP(3))', [userId,key,hash,JSON.stringify(result)])
        await db.commit(); return result
      } catch (error) { await db.rollback(); throw error } finally { db.release() }
    },
    async inbox(userId: number) {
      const [items] = await pool.execute<RowDataPacket[]>(`SELECT id,kind,resource_id,title,summary,actionable,created_at_utc,read_at_utc FROM user_notifications_v4 WHERE user_id=? ORDER BY created_at_utc DESC,id DESC LIMIT 50`, [userId])
      const [counts] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) unread FROM user_notifications_v4 WHERE user_id=? AND read_at_utc IS NULL', [userId])
      return { items: items.map(r => ({ id: r.id, kind: r.kind, resourceId: r.resource_id, title: r.title, summary: r.summary, actionable: Number(r.actionable) === 1, createdAt: r.created_at_utc.toISOString(), read: !!r.read_at_utc })), unread: Number(counts[0]?.unread ?? 0) }
    },
    async markAllRead(userId: number) {
      await pool.execute('UPDATE user_notifications_v4 SET read_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND read_at_utc IS NULL', [userId])
      return { read: true }
    },
    async markRead(userId: number, id: string) {
      await pool.execute('UPDATE user_notifications_v4 SET read_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND id=? AND read_at_utc IS NULL', [userId,id])
      return { read: true }
    },
  }
}
export type NotificationSettings = ReturnType<typeof createNotificationSettings>
