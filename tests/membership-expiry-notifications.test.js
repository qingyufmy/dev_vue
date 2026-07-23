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
  ensureMembershipExpiryNotifications,
  getPendingWebMembershipReminder,
  normalizeReminderSurface,
  processMembershipExpiryDeliveries,
} from '../server/membership-expiry-notifications.js'

describe('membership expiry notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryRun.mockResolvedValue({ changes:1, insertId:1 })
    queryAll.mockResolvedValue([])
    queryOne.mockResolvedValue(null)
    loadSmsConfig.mockResolvedValue({ templateCodes:{ membership_expiry:'SMS_EXPIRY' } })
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
})
