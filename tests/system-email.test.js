import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryAll, createTransport, sendMail } = vi.hoisted(() => ({
  queryAll:vi.fn(), createTransport:vi.fn(), sendMail:vi.fn(),
}))
vi.mock('../server/db.js', () => ({ queryAll }))
vi.mock('nodemailer', () => ({ default:{ createTransport } }))

import { classifyEmailSendError, sendUserNotificationEmail } from '../server/system-email.js'

describe('system email delivery classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryAll.mockResolvedValue([
      { key:'host', value:'smtp.test' }, { key:'user', value:'sender@test' },
      { key:'pass', value:'secret' }, { key:'from', value:'sender@test' },
    ])
    sendMail.mockResolvedValue({ response:'250 accepted', messageId:'provider-id' })
    createTransport.mockReturnValue({ sendMail })
  })

  it('marks transport timeouts as unknown and non-retryable', () => {
    expect(classifyEmailSendError({ code:'ETIMEDOUT', message:'socket timeout' })).toMatchObject({ status:'unknown', retryable:false })
  })

  it('keeps connection refusal retryable while rejecting permanent SMTP errors', () => {
    expect(classifyEmailSendError({ code:'ECONNREFUSED' })).toMatchObject({ status:'failed', retryable:true })
    expect(classifyEmailSendError({ responseCode:550 })).toMatchObject({ status:'failed', retryable:false })
  })

  it('converts validated relative links to the public absolute URL and rejects unsafe links', async () => {
    const previous = process.env.PUBLIC_SITE_URL
    process.env.PUBLIC_SITE_URL = 'https://example.test/'
    await sendUserNotificationEmail({ to:'user@test', title:'通知', message:'正文', link:'/account/?tab=notifications', messageId:'<stable@test>' })
    const first = sendMail.mock.calls[0][0]
    expect(first.text).toContain('https://example.test/account/?tab=notifications')
    expect(first.html).toContain('href="https://example.test/account/?tab=notifications"')
    await sendUserNotificationEmail({ to:'user@test', title:'通知', message:'正文', link:'https://evil.test' })
    const second = sendMail.mock.calls[1][0]
    expect(second.html).not.toContain('href=')
    await sendUserNotificationEmail({ to:'user@test', title:'通知', message:'正文', link:'/admin/users' })
    const third = sendMail.mock.calls[2][0]
    expect(third.html).not.toContain('href=')
    if (previous === undefined) delete process.env.PUBLIC_SITE_URL
    else process.env.PUBLIC_SITE_URL = previous
  })
})
