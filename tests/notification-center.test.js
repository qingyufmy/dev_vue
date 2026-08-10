import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryOne:vi.fn(), queryAll:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(), logAudit:vi.fn(),
}))
vi.mock('../server/config.js', () => ({ JWT_SECRET:'test-secret' }))
vi.mock('../server/system-email.js', () => ({ sendUserNotificationEmail:vi.fn() }))
vi.mock('../server/bridge-ws.js', () => ({ sendNotificationCreatedToUser:vi.fn() }))

import {
  buildNotificationRecipientWhere,
  normalizeNotificationContent,
  normalizeNotificationScope,
  notificationEmailMessageId,
  previewNotifications,
  processNotificationCampaign,
  retryFailedNotificationEmails,
  validateInternalNotificationLink,
  verifyNotificationPreviewToken,
} from '../server/notification-center.js'
import { queryOne, queryAll, queryRun, withTransaction } from '../server/db.js'
import { sendUserNotificationEmail } from '../server/system-email.js'

describe('notification center domain rules', () => {
  beforeEach(() => { vi.clearAllMocks(); queryRun.mockResolvedValue({ changes:1, insertId:101 }) })
  it('uses the existing membership and observer-source markers when filtering recipients', () => {
    const criteria = normalizeNotificationScope({ recipientScope:'plans', recipientFilter:{ plans:['plus', 'expired'] } })
    const result = buildNotificationRecipientWhere(criteria.recipientScope, criteria.recipientFilter)
    expect(result.where).toContain("COALESCE(u.plan_source, '') <> 'observer_source'")
    expect(result.where).toContain('u.plan_expires_at >= NOW()')
    expect(result.where).toContain('u.plan_expires_at < NOW()')
    expect(result.params).toEqual(['plus'])
  })

  it('accepts only controlled same-origin account and AI links', () => {
    expect(validateInternalNotificationLink('/')).toBe('/')
    expect(validateInternalNotificationLink('/account/?tab=notifications')).toBe('/account/?tab=notifications')
    expect(validateInternalNotificationLink('/ai/?symbol=XAUUSD')).toBe('/ai/?symbol=XAUUSD')
    for (const value of [
      'https://evil.test', 'https://aurum.invalid/account/', '//evil.test',
      '/%2e%2e/account/', '/account/%2E%2E/admin/', '/%2f%2fevil.test', '/%5caccount/',
      '/admin/', '/api/users', '/account/?token=secret', 'javascript:alert(1)',
    ]) {
      expect(() => validateInternalNotificationLink(value)).toThrow()
    }
  })

  it('binds a preview token to the actor, content, range and recipient count', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('COUNT(*) AS recipient_count')) return { recipient_count:1, email_reachable_count:1 }
      if (sql.includes('total_count')) return { total_count:1 }
      return null
    })
    queryAll.mockResolvedValue([{ id:4, uid:'U4', nickname:'用户', email:'u@example.test', plan:'free', plan_expires_at:null, membership_expired:0 }])
    const body = { recipientScope:'user', recipientFilter:{ userId:4 }, title:'标题', message:'正文', priority:'normal' }
    const preview = await previewNotifications(9, body)
    expect(preview.recipientCount).toBe(1)
    expect(verifyNotificationPreviewToken(preview.token, 9,
      normalizeNotificationScope(body), normalizeNotificationContent(body), 1)).toBe(true)
    expect(verifyNotificationPreviewToken(preview.token, 10,
      normalizeNotificationScope(body), normalizeNotificationContent(body), 1)).toBe(false)
  })

  it('keeps a deterministic message id for manual email retry', () => {
    expect(notificationEmailMessageId(12, 34)).toBe(notificationEmailMessageId(12, 34))
    expect(notificationEmailMessageId(12, 34)).toContain('aurum-notification-12-34')
  })

  it('keeps a retryable SMTP failure in sending until its next attempt is due', async () => {
    const campaign = { id:12, title:'标题', message:'正文', link:null, priority:'normal', requires_ack:0, in_app_enabled:1, email_enabled:1, preview_recipient_count:0, status:'queued' }
    const runner = vi.fn(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return [[campaign]]
      if (sql.includes('SELECT COUNT(*) AS c FROM notification_deliveries')) return [[{ c:0 }]]
      return [{ affectedRows:1 }]
    })
    withTransaction.mockImplementation(async callback => callback(runner))
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return { ...campaign, status:'sending' }
      if (sql.includes("status IN ('pending', 'sending')")) return { c:1 }
      if (sql.includes("status = 'unknown'")) return { c:0 }
      return null
    })
    queryAll.mockImplementation(async sql => {
      if (sql.includes("channel = 'in_app'")) return []
      if (sql.includes("channel = 'email'")) return [{ id:7, user_id:9, attempt_count:0, email:'u@example.test', email_verified:1, deletion_status:'active', deleted_at:null }]
      return []
    })
    sendUserNotificationEmail.mockResolvedValue({ sent:false, status:'failed', retryable:true, error:'邮件发送失败' })
    const result = await processNotificationCampaign(12)
    expect(result.status).toBe('sending')
    expect(queryRun.mock.calls.some(([sql]) => sql.includes("status = 'failed'"))).toBe(true)
  })

  it('does not re-send a terminal failed email on every worker tick', async () => {
    const campaign = { id:14, title:'标题', message:'正文', link:null, priority:'normal', requires_ack:0, in_app_enabled:1, email_enabled:1, preview_recipient_count:0, status:'queued' }
    withTransaction.mockImplementation(async callback => callback(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return [[campaign]]
      if (sql.includes('SELECT COUNT(*) AS c FROM notification_deliveries')) return [[{ c:0 }]]
      return [{ affectedRows:1 }]
    }))
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return { ...campaign, status:'sending' }
      if (sql.includes("status IN ('pending', 'sending')")) return { c:0 }
      if (sql.includes("next_attempt_at IS NULL")) return { c:1 }
      return null
    })
    let emailQuery = ''
    queryAll.mockImplementation(async sql => {
      if (sql.includes("channel = 'in_app'")) return []
      if (sql.includes("channel = 'email'")) {
        emailQuery = sql
        // An implementation with the old broad status IN ('pending','failed')
        // predicate would incorrectly receive this terminal row.
        if (sql.includes("status IN ('pending', 'failed')")) {
          return [{ id:9, user_id:9, attempt_count:5, email:'u@example.test', email_verified:1, deletion_status:'active', deleted_at:null, status:'failed', next_attempt_at:null }]
        }
        return []
      }
      return []
    })
    const result = await processNotificationCampaign(14)
    expect(result.status).toBe('sending')
    expect(queryRun.mock.calls.some(([sql, params]) => sql.includes('UPDATE notification_campaigns SET status = ?') && params.includes('partial_failed'))).toBe(true)
    expect(sendUserNotificationEmail).not.toHaveBeenCalled()
    expect(emailQuery).toContain("status = 'pending'")
    expect(emailQuery).toContain("status = 'failed' AND d.next_attempt_at IS NOT NULL")
  })

  it('claims a retryable failed email after its next attempt is due', async () => {
    const campaign = { id:15, title:'标题', message:'正文', link:null, priority:'normal', requires_ack:0, in_app_enabled:1, email_enabled:1, preview_recipient_count:0, status:'queued' }
    withTransaction.mockImplementation(async callback => callback(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return [[campaign]]
      if (sql.includes('SELECT COUNT(*) AS c FROM notification_deliveries')) return [[{ c:0 }]]
      return [{ affectedRows:1 }]
    }))
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return { ...campaign, status:'sending' }
      if (sql.includes("status IN ('pending', 'sending')")) return { c:0 }
      if (sql.includes("next_attempt_at IS NULL")) return { c:0 }
      return null
    })
    let emailQuery = ''
    queryAll.mockImplementation(async sql => {
      if (sql.includes("channel = 'in_app'")) return []
      if (sql.includes("channel = 'email'")) {
        emailQuery = sql
        return [{ id:10, user_id:9, attempt_count:1, email:'u@example.test', email_verified:1, deletion_status:'active', deleted_at:null, status:'failed', next_attempt_at:'2026-08-10 17:00:00' }]
      }
      return []
    })
    sendUserNotificationEmail.mockResolvedValue({ sent:true, status:'sent', providerResponseSummary:'250 accepted' })
    const result = await processNotificationCampaign(15)
    expect(result.status).toBe('sending')
    expect(queryRun.mock.calls.some(([sql, params]) => sql.includes('UPDATE notification_campaigns SET status = ?') && params.includes('completed'))).toBe(true)
    expect(sendUserNotificationEmail).toHaveBeenCalledTimes(1)
    expect(emailQuery).toContain("status = 'failed' AND d.next_attempt_at IS NOT NULL")
  })

  it('does not automatically retry an unknown SMTP result', async () => {
    const campaign = { id:13, title:'标题', message:'正文', link:null, priority:'normal', requires_ack:0, in_app_enabled:1, email_enabled:1, preview_recipient_count:0, status:'queued' }
    withTransaction.mockImplementation(async callback => callback(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return [[campaign]]
      if (sql.includes('SELECT COUNT(*) AS c FROM notification_deliveries')) return [[{ c:0 }]]
      return [{ affectedRows:1 }]
    }))
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM notification_campaigns')) return { ...campaign, status:'sending' }
      if (sql.includes("status IN ('pending', 'sending')")) return { c:0 }
      if (sql.includes("status = 'unknown'")) return { c:1 }
      return null
    })
    queryAll.mockImplementation(async sql => sql.includes("channel = 'email'")
      ? [{ id:8, user_id:9, attempt_count:0, email:'u@example.test', email_verified:1, deletion_status:'active', deleted_at:null }]
      : [])
    sendUserNotificationEmail.mockResolvedValue({ sent:false, status:'unknown', retryable:false, error:'邮件服务响应不明' })
    const result = await processNotificationCampaign(13)
    expect(queryRun.mock.calls.some(([sql, params]) => sql.includes('SET status = ?') && params.includes('partial_failed'))).toBe(true)
    expect(sendUserNotificationEmail).toHaveBeenCalledTimes(1)
  })

  it('does not revive a cancelled campaign during manual email retry', async () => {
    queryOne.mockImplementation(async sql => {
      if (sql.includes('notification_idempotency_keys')) return null
      if (sql.includes('SELECT * FROM notification_campaigns')) return { id:16, status:'cancelled' }
      return null
    })
    await expect(retryFailedNotificationEmails(7, 16, { idempotencyKey:'retry-cancelled' }))
      .rejects.toMatchObject({ code:'campaign_not_retryable' })
    expect(queryRun).not.toHaveBeenCalled()
  })
})
