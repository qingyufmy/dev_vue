import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlAnalysisScheduleStore } from '../src/modules/strategies/infrastructure/mysql-analysis-schedule-store.js'

describe('analysis schedule query bounds', () => {
  it('advances only the expected due time and reports a concurrent change without retrying', async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{ affectedRows: 0 }])
    const repo = new MysqlAnalysisScheduleStore({ execute } as unknown as Pool)
    const expected = '2026-09-09T00:00:00.000Z', next = '2026-09-09T00:05:00.000Z'
    expect(await repo.advance('7', expected, next)).toBe(true)
    expect(await repo.advance('7', expected, next)).toBe(false)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0]).toEqual([
      expect.stringContaining('WHERE subscription_id=? AND next_due_at_utc=?'), ['2026-09-09 00:05:00.000', '7', '2026-09-09 00:00:00.000'],
    ])
    execute.mockRejectedValueOnce(Error('database_unavailable'))
    await expect(repo.advance('7', expected, next)).rejects.toThrow('database_unavailable')
    expect(execute).toHaveBeenCalledTimes(3)
  })
  it('rejects fractional and out-of-range limits before querying', async () => {
    let calls = 0
    const repo = new MysqlAnalysisScheduleStore({ async execute() { calls += 1; return [[]] } } as unknown as Pool)
    for (const limit of [0, -1, 1.5, 501, NaN, Infinity]) await expect(repo.listDue('2026-09-07T00:00:00Z', limit)).rejects.toThrow('analysis_schedule_limit_invalid')
    expect(calls).toBe(0)
    await repo.listDue('2026-09-07T00:00:00Z', 500)
    expect(calls).toBe(1)
  })
})
