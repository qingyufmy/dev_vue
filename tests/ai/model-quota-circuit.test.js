import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()
const mockListAdmins = vi.fn()
const mockSendEmail = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne:(...args) => mockQueryOne(...args),
  queryRun:(...args) => mockQueryRun(...args),
}))

vi.mock('../../server/system-email.js', () => ({
  listAdminAlertRecipients:(...args) => mockListAdmins(...args),
  sendSystemEmail:(...args) => mockSendEmail(...args),
}))

import {
  assertModelQuotaAvailable,
  buildModelQuotaCircuitContext,
  keepModelQuotaIncidentOpen,
  recordModelQuotaExhausted,
  recordModelQuotaRecovered,
} from '../../server/routes/ai/model-quota-circuit.js'

const context = buildModelQuotaCircuitContext({
  usageContext:{ profileId:7 },
  provider:'deepseek',
  model:'deepseek-v4-pro',
  url:'https://api.deepseek.com/v1/chat/completions',
})

beforeEach(() => {
  vi.clearAllMocks()
  mockListAdmins.mockResolvedValue(['admin@example.com'])
  mockSendEmail.mockResolvedValue({ sent:true, recipients:1 })
  mockQueryRun.mockResolvedValue({ changes:1 })
})

describe('model quota incident identity', () => {
  it('is stable per model profile and does not activate without a durable profile', () => {
    const again = buildModelQuotaCircuitContext({
      usageContext:{ profileId:7 }, provider:'deepseek', model:'deepseek-v4-pro',
      url:'https://api.deepseek.com/v1/chat/completions',
    })
    expect(again.circuitKey).toBe(context.circuitKey)
    expect(buildModelQuotaCircuitContext({ provider:'deepseek', model:'x', url:'https://example.com' })).toBeNull()
  })
})

describe('model quota incident state', () => {
  it('allows normal provider requests while a quota incident is open', async () => {
    mockQueryOne.mockResolvedValue({ status:'open', error_count:3 })
    await expect(assertModelQuotaAvailable(context)).resolves.toEqual({
      recoveryCandidate:true, incidentErrorCount:3,
    })
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not mark normal traffic as recovery traffic without an open incident', async () => {
    mockQueryOne.mockResolvedValue({ status:'recovered' })
    await expect(assertModelQuotaAvailable(context)).resolves.toEqual({
      recoveryCandidate:false, incidentErrorCount:null,
    })
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('records the incident without a timed circuit and sends one deduplicated administrator email', async () => {
    mockQueryRun
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    await recordModelQuotaExhausted(context, 'LLM HTTP 429')
    expect(mockQueryRun.mock.calls[0][0]).not.toContain('DATE_ADD')
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('返回 429')
    expect(mockSendEmail.mock.calls[0][0].html).toContain('不会设置定时熔断')
    expect(mockSendEmail.mock.calls[0][0].html).not.toContain('api-key')
  })

  it('does not resend an alert inside the database deduplication window', async () => {
    mockQueryRun
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:0 })
    await recordModelQuotaExhausted(context, 'LLM HTTP 429')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('marks the matching incident recovered and sends a recovery email once', async () => {
    mockQueryRun.mockResolvedValue({ changes:1 })
    await recordModelQuotaRecovered(context, { incidentErrorCount:3 })
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('恢复')
    expect(mockSendEmail.mock.calls[0][0].html).not.toContain('恢复探测')
    expect(mockQueryRun.mock.calls[0][0]).toContain('error_count = ?')
    expect(mockQueryRun.mock.calls[0][1]).toEqual([context.circuitKey, 3])
  })

  it('does not let a stale success recover a newer 429 incident', async () => {
    mockQueryRun.mockResolvedValue({ changes:0 })
    await recordModelQuotaRecovered(context, { incidentErrorCount:3 })
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('keeps an unresolved incident open without adding a retry delay', async () => {
    mockQueryRun.mockResolvedValue({ changes:1 })
    await keepModelQuotaIncidentOpen(context)
    expect(mockQueryRun.mock.calls[0][0]).toContain('open_until = NULL')
    expect(mockQueryRun.mock.calls[0][0]).not.toContain('DATE_ADD')
  })
})
