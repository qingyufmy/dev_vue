import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const mockQueryAll = vi.fn()
const mockWithTransaction = vi.fn()
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
}

vi.mock('../server/db.js', () => ({
  queryAll: mockQueryAll,
  withTransaction: mockWithTransaction,
}))

vi.mock('../server/redis.js', () => ({
  getRedis: () => mockRedis,
}))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.HOLD_SIGNAL_CLEANUP_ENABLED
  delete process.env.HOLD_SIGNAL_CLEANUP_BATCH_SIZE
  mockRedis.eval.mockResolvedValue(1)
})

describe('hold signal cleanup schedule', () => {
  it('calculates the next Beijing 04:30 boundary', async () => {
    const { nextCleanupDelay, cleanupDueToday, beijingBusinessDate } = await import('../server/jobs/hold-signal-cleanup.js')

    expect(nextCleanupDelay(new Date('2026-07-11T20:00:00.000Z'))).toBe(30 * 60 * 1000)
    expect(nextCleanupDelay(new Date('2026-07-11T20:31:00.000Z'))).toBe((23 * 60 + 59) * 60 * 1000)
    expect(cleanupDueToday(new Date('2026-07-11T20:29:00.000Z'))).toBe(false)
    expect(cleanupDueToday(new Date('2026-07-11T20:30:00.000Z'))).toBe(true)
    expect(beijingBusinessDate(new Date('2026-07-11T20:30:00.000Z'))).toBe('2026-07-12')
  })
})

describe('deleteExpiredHoldSignals', () => {
  it('deletes inference artifacts and deliveries before signals in one transaction', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 3 }])
      .mockResolvedValueOnce([{ affectedRows: 2 }])
    mockQueryAll
      .mockResolvedValueOnce([{ id: 11 }, { id: 12 }])
      .mockResolvedValueOnce([])
    mockWithTransaction.mockImplementation(async fn => fn(run))
    const { deleteExpiredHoldSignals } = await import('../server/jobs/hold-signal-cleanup.js')

    const result = await deleteExpiredHoldSignals({ limit: 2 })

    expect(mockQueryAll.mock.calls[0][0]).toContain("signal_type = 'hold'")
    expect(mockQueryAll.mock.calls[0][0]).toContain('DATE_SUB(CURDATE(), INTERVAL 1 DAY)')
    expect(run.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('DELETE FROM memory_injection_logs'),
      expect.stringContaining('DELETE FROM inference_snapshots'),
      expect.stringContaining('DELETE FROM auto_signal_deliveries'),
      expect.stringContaining('DELETE FROM ai_signals'),
    ])
    expect(run.mock.calls[3][0]).toContain("signal_type = 'hold'")
    expect(result).toEqual({ deletedSignals: 2, deletedDeliveries: 3, deletedSnapshots: 2,
      deletedMemoryLogs: 2, batches: 1 })
  })
})

describe('orphan inference artifact migration', () => {
  it('removes only snapshots that have neither a signal nor retained outcome/review evidence', () => {
    const source = readFileSync(new URL('../server/migrations.js', import.meta.url), 'utf8')
    const start = source.indexOf("id: '099_cleanup_orphan_inference_artifacts'")
    const block = source.slice(start, source.indexOf('\n  }\n]', start))
    expect(block).toContain('DELETE snapshot_row FROM inference_snapshots')
    expect(block).toContain('outcome_row.id IS NULL AND review_row.id IS NULL')
    expect(block).toContain('DELETE memory_log FROM memory_injection_logs')
    expect(source).toContain("id: '135_remove_paired_inference_experiment'")
    expect(source).toContain('DROP TABLE IF EXISTS ai_paired_inference_runs')
  })
})

describe('runHoldSignalCleanup', () => {
  it('does not rerun after a successful cleanup on the same Beijing date', async () => {
    mockRedis.get.mockResolvedValue('2026-07-12')
    const { runHoldSignalCleanup } = await import('../server/jobs/hold-signal-cleanup.js')

    const result = await runHoldSignalCleanup(new Date('2026-07-11T21:00:00.000Z'))

    expect(result.status).toBe('already_completed')
    expect(mockRedis.set).not.toHaveBeenCalled()
    expect(mockQueryAll).not.toHaveBeenCalled()
  })

  it('locks, cleans, records success without expiry, and releases by token', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockRedis.set.mockResolvedValue('OK')
    mockQueryAll.mockResolvedValue([])
    const { runHoldSignalCleanup } = await import('../server/jobs/hold-signal-cleanup.js')

    const result = await runHoldSignalCleanup(new Date('2026-07-11T21:00:00.000Z'))

    expect(result.status).toBe('completed')
    expect(mockRedis.set.mock.calls[0].slice(0, 3)).toEqual([
      'maintenance:hold_signal_cleanup:lock', expect.any(String), 'NX'
    ])
    expect(mockRedis.set).toHaveBeenCalledWith('maintenance:hold_signal_cleanup:last_success', '2026-07-12')
    expect(mockRedis.eval).toHaveBeenLastCalledWith(
      expect.any(String), 1, 'maintenance:hold_signal_cleanup:lock', expect.any(String)
    )
  })
})
