import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('notification center migration contract', () => {
  const source = readFileSync(new URL('../server/migrations.js', import.meta.url), 'utf8')

  it('appends the idempotent migration after migration 176', () => {
    expect(source.indexOf("id: '176_unified_video_storage_links'")).toBeGreaterThanOrEqual(0)
    expect(source.indexOf("id: '177_notification_center'")).toBeGreaterThan(
      source.indexOf("id: '176_unified_video_storage_links'"),
    )
    expect(source).toContain("TABLE_NAME = 'notifications'")
    expect(source).toContain('idx_notifications_user_read_created')
    for (const column of ['campaign_id', 'priority', 'requires_ack', 'read_at', 'acknowledged_at']) {
      expect(source).toContain(`['${column}',`)
    }
  })

  it('keeps campaign and delivery uniqueness in the database schema', () => {
    expect(source).toContain('CREATE TABLE IF NOT EXISTS notification_campaigns')
    expect(source).toContain('UNIQUE KEY uk_notification_campaign_idempotency (created_by, idempotency_key)')
    expect(source).toContain('CREATE TABLE IF NOT EXISTS notification_deliveries')
    expect(source).toContain('UNIQUE KEY uk_notification_delivery (campaign_id, user_id, channel)')
    expect(source).toContain('CREATE TABLE IF NOT EXISTS notification_idempotency_keys')
  })
})
