import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQueryRun } = vi.hoisted(() => ({ mockQueryRun: vi.fn() }))

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: mockQueryRun,
  withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-13 23:30:00'),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: vi.fn(),
}))

import { insertAudit } from '../../server/routes/ai/config.js'

describe('insertAudit', () => {
  beforeEach(() => mockQueryRun.mockClear())

  it('writes Chinese action, status and result values', async () => {
    await insertAudit(null, 7, 'ai_auto_execute_rejected', 'XAUUSD',
      { reason: 'volume_exceeds_config_limit' },
      { status: 'rejected', message: 'volume_exceeds_config_limit' },
      'rejected')

    expect(mockQueryRun).toHaveBeenCalledTimes(1)
    const params = mockQueryRun.mock.calls[0][1]
    expect(params[1]).toBe('AI 自动执行拒绝')
    expect(params[5]).toBe('已拒绝')
    expect(JSON.parse(params[3]).reason).toBe('手数超过配置上限')
    expect(JSON.parse(params[4])).toMatchObject({ status: '已拒绝', message: '手数超过配置上限' })
  })

  it('does not write normal hold audits', async () => {
    const written = await insertAudit(null, 7, 'ai_auto_scan', 'XAUUSD', {},
      { status: 'skipped_hold', signal_type: 'hold' }, 'success')

    expect(written).toBe(false)
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('writes normal success audits and non-skipped hold-related audits', async () => {
    await insertAudit(null, 7, 'ai_auto_scan', 'XAUUSD', {},
      { status: 'success', signal_type: 'buy' }, 'success')
    await insertAudit(null, 7, 'ai_execute', 'XAUUSD', { signal_type: 'hold' },
      { status: 'rejected', reason: 'hold_signal_cannot_execute' }, 'rejected')

    expect(mockQueryRun).toHaveBeenCalledTimes(2)
    expect(mockQueryRun.mock.calls[0][1][5]).toBe('成功')
    expect(mockQueryRun.mock.calls[1][1][5]).toBe('已拒绝')
  })
})
