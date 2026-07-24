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

describe('model quota circuit identity', () => {
  it('is stable per model profile and does not activate without a durable profile', () => {
    const again = buildModelQuotaCircuitContext({
      usageContext:{ profileId:7 }, provider:'deepseek', model:'deepseek-v4-pro',
      url:'https://api.deepseek.com/v1/chat/completions',
    })
    expect(again.circuitKey).toBe(context.circuitKey)
    expect(buildModelQuotaCircuitContext({ provider:'deepseek', model:'x', url:'https://example.com' })).toBeNull()
  })
})

describe('model quota circuit state', () => {
  it('blocks provider requests while the quota circuit is open', async () => {
    mockQueryOne.mockResolvedValue({ status:'open', is_blocked:1, probe_busy:0, open_until:'2026-07-24 14:00:00' })
    await expect(assertModelQuotaAvailable(context)).rejects.toMatchObject({
      message:'model_quota_exhausted', code:'model_quota_exhausted', modelQuotaCircuit:true,
    })
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('atomically claims one recovery probe after the circuit delay', async () => {
    mockQueryOne.mockResolvedValue({ status:'open', is_blocked:0, probe_busy:0 })
    mockQueryRun.mockResolvedValue({ changes:1 })
    await expect(assertModelQuotaAvailable(context)).resolves.toEqual({ probe:true })
    expect(mockQueryRun.mock.calls[0][0]).toContain('probe_lease_until')
  })

  it('opens the circuit and sends one deduplicated administrator email', async () => {
    mockQueryRun
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:1 })
    await recordModelQuotaExhausted(context, 'LLM HTTP 429')
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('额度已耗尽')
    expect(mockSendEmail.mock.calls[0][0].html).not.toContain('api-key')
  })

  it('does not resend an alert inside the database deduplication window', async () => {
    mockQueryRun
      .mockResolvedValueOnce({ changes:1 })
      .mockResolvedValueOnce({ changes:0 })
    await recordModelQuotaExhausted(context, 'LLM HTTP 429')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('closes the circuit and sends a recovery email once', async () => {
    mockQueryRun.mockResolvedValue({ changes:1 })
    await recordModelQuotaRecovered(context)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('恢复')
  })
})
