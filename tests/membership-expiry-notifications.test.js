import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db.js', () => ({
  queryAll:vi.fn(),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
}))

vi.mock('../server/sms.js', () => ({
  loadSmsConfig:vi.fn(),
  sendSms:vi.fn(),
}))

const sendMail = vi.fn()
vi.mock('nodemailer', () => ({
  default:{ createTransport:vi.fn(() => ({ sendMail })) },
}))

import { queryAll, queryOne, queryRun } from '../server/db.js'
import { loadSmsConfig, sendSms } from '../server/sms.js'
import {
  acknowledgeWebMembershipReminder,
  buildMembershipExpiryCopy,
  cancelStaleMembershipExpiryNotifications,
  ensureMembershipExpiryNotifications,
  getAdminMembershipExpiryNotifications,
  getPendingWebMembershipReminder,
  membershipDeliveryErrorText,
  normalizeReminderSurface,
  processMembershipExpiryDeliveries,
} from '../server/membership-expiry-notifications.js'

describe('membership expiry notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryRun.mockResolvedValue({ changes:1, insertId:1 })
    queryAll.mockResolvedValue([])
    queryOne.mockResolvedValue(null)
    loadSmsConfig.mockResolvedValue({ templateCodes:{ membership_expiry:'SMS_EXPIRY', membership_expired:'SMS_EXPIRED' } })
    sendMail.mockResolvedValue({ messageId:'mail-1' })
    sendSms.mockResolvedValue({ code:'OK' })
  })

  it('builds concise Chinese copy and separates the two web surfaces', () => {
    expect(buildMembershipExpiryCopy({
      plan:'pro', plan_expires_at:'2026-07-30 23:59:59', days_before:7,
    })).toMatchObject({
      title:'Pro 会员将在 7 天后到期',
      expiry_date:'2026-07-30',
      expiry_date_text:'2026年7月30日',
      days_before:7,
    })
    expect(normalizeReminderSurface('main')).toBe('web_main')
    expect(normalizeReminderSurface('ai')).toBe('web_ai')
    expect(buildMembershipExpiryCopy({
      plan:'plus', plan_expires_at:'2026-07-22 23:59:59', days_before:0,
    })).toMatchObject({
      title:'Plus 会员已过期',
      summary:'您的 Plus 会员已于 2026年7月22日到期，续费后可恢复会员权益。',
      days_before:0,
    })
  })

  it('does not create an SMS delivery when the user has no phone number', async () => {
    queryAll.mockResolvedValueOnce([{
      id:9, email:'u@example.com', phone:null, nickname:'用户',
      plan:'pro', plan_expires_at:'2026-07-30 23:59:59', days_before:3,
    }])
    const result = await ensureMembershipExpiryNotifications(9)
    expect(result).toEqual({ users:1, created:3 })
    expect(queryRun.mock.calls.map(call => call[1][4])).toEqual(['web_main', 'web_ai', 'email'])
  })

  it('creates one expired-stage record per available channel regardless of how late the worker runs', async () => {
    queryAll.mockResolvedValueOnce([{
      id:10, email:'u@example.com', phone:'13800138000', nickname:'用户',
      plan:'pro', plan_expires_at:'2026-07-20 23:59:59', days_before:0,
    }])
    await ensureMembershipExpiryNotifications(10)
    expect(queryRun).toHaveBeenCalledTimes(4)
    expect(queryRun.mock.calls.every(call => call[1][3] === 0)).toBe(true)
    expect(queryAll.mock.calls[0][0]).toContain('plan_expires_at < NOW()')
  })

  it('creates one idempotent record for each delivery channel', async () => {
    queryAll.mockResolvedValueOnce([{
      id:8, email:'u@example.com', phone:'13800138000', nickname:'用户',
      plan:'plus', plan_expires_at:'2026-07-30 23:59:59', days_before:7,
    }])
    const result = await ensureMembershipExpiryNotifications(8)
    expect(result).toEqual({ users:1, created:4 })
    expect(queryRun).toHaveBeenCalledTimes(4)
    expect(queryRun.mock.calls.map(call => call[1][4])).toEqual(['web_main', 'web_ai', 'email', 'sms'])
    expect(queryAll.mock.calls[0][1]).toEqual([7, 3, 2, 1, 8])
  })

  it('claims and sends email and SMS once through their configured providers', async () => {
    queryAll.mockImplementation(async sql => {
      if (sql.includes("category = 'smtp'")) return [
        { key:'host', value:'smtp.example.com' },
        { key:'user', value:'mailer@example.com' },
        { key:'pass', value:'secret' },
      ]
      if (sql.includes('FROM membership_expiry_notifications')) return [
        { id:11, channel:'email', email:'u@example.com', plan:'pro', plan_expires_at:'2026-07-30 23:59:59', days_before:7 },
        { id:12, channel:'sms', phone:'13800138000', plan:'pro', plan_expires_at:'2026-07-30 23:59:59', days_before:7 },
      ]
      return []
    })
    const result = await processMembershipExpiryDeliveries()
    expect(result).toMatchObject({ selected:2, sent:2, failed:0 })
    expect(sendMail).toHaveBeenCalledOnce()
    expect(sendSms).toHaveBeenCalledWith('13800138000', 'SMS_EXPIRY', {
      plan:'Pro', expire_date:'2026-07-30', days:'7',
    })
    expect(queryRun.mock.calls.filter(call => call[0].includes("status = 'sending'"))).toHaveLength(4)
  })

  it('uses the dedicated expired-membership SMS template without a days parameter', async () => {
    queryAll.mockImplementation(async sql => {
      if (sql.includes("category = 'smtp'")) return []
      if (sql.includes('FROM membership_expiry_notifications')) return [
        { id:13, channel:'sms', phone:'13800138000', plan:'pro', plan_expires_at:'2026-07-20 23:59:59', days_before:0 },
      ]
      return []
    })
    const result = await processMembershipExpiryDeliveries()
    expect(result).toMatchObject({ selected:1, sent:1, failed:0 })
    expect(sendSms).toHaveBeenCalledWith('13800138000', 'SMS_EXPIRED', {
      plan:'Pro', expire_date:'2026-07-20',
    })
  })

  it('returns and acknowledges only the requested web surface', async () => {
    queryOne.mockResolvedValueOnce({
      id:21, plan:'plus', plan_expires_at:'2026-07-26 23:59:59', days_before:3,
    })
    const reminder = await getPendingWebMembershipReminder(9, 'ai')
    expect(reminder).toMatchObject({ id:21, title:'Plus 会员将在 3 天后到期' })
    expect(queryOne.mock.calls[0][1]).toEqual([9, 'web_ai'])

    await expect(acknowledgeWebMembershipReminder(9, 21, 'ai')).resolves.toBe(true)
    expect(queryRun.mock.calls.at(-1)[1]).toEqual([21, 9, 'web_ai'])
  })

  it('archives obsolete pending reminders after renewal or a changed reminder window', async () => {
    queryRun.mockResolvedValueOnce({ changes:3 })
    await expect(cancelStaleMembershipExpiryNotifications()).resolves.toBe(3)
    expect(queryRun.mock.calls[0][0]).toContain("status = 'cancelled'")
    expect(queryRun.mock.calls[0][0]).toContain('users.plan_expires_at <> notifications.plan_expires_at')
  })

  it('returns localized administrator audit data without exposing provider errors', async () => {
    loadSmsConfig.mockResolvedValueOnce({ templateCodes:{ membership_expiry:'' } })
    queryAll.mockImplementation(async sql => {
      if (sql.includes("category = 'smtp'")) return [{ key:'host', value:'smtp.example.com' }, { key:'user', value:'mailer@example.com' }]
      if (sql.includes('GROUP BY status, channel')) return [{ status:'failed', channel:'email', count:1 }]
      if (sql.includes('SELECT notifications.id')) return [{
        id:31, user_id:9, plan:'pro', plan_expires_at:'2026-07-30 00:00:00', days_before:7,
        channel:'email', status:'failed', attempt_count:2, last_error:'SMTP authentication failed',
      }]
      return []
    })
    queryOne.mockResolvedValueOnce({ count:1 })
    const data = await getAdminMembershipExpiryNotifications({ page:1, status:'failed' })
    expect(data.summary).toMatchObject({ total:1, failed:1 })
    expect(data.records[0]).toMatchObject({
      delivery_state:'failed', error_text:'通知服务账号认证失败，请检查服务配置', retry_allowed:true,
    })
    expect(data.records[0]).not.toHaveProperty('last_error')
    expect(data.providerConfigured).toEqual({
      email:true, sms:false, sms_expiry:false, sms_expired:false,
    })
  })

  it('translates common delivery failures into operational Chinese', () => {
    expect(membershipDeliveryErrorText('ETIMEDOUT')).toBe('通知服务连接超时，请稍后重试')
    expect(membershipDeliveryErrorText('isv.BUSINESS_LIMIT_CONTROL')).toBe('发送频率受到服务商限制，请稍后重试')
  })
})
