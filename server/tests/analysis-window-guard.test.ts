import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlAnalysisWindowGuard, type AnalysisRun } from '../src/modules/inference/index.js'

const run = { trigger: 'scheduled', userId: 42, marketSourceAccountId: '7', strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD' } as AnalysisRun
const window = { enabled: true, version: 1, timezone: 'terminal_server', weekdays: [1], windows: [{ start: '22:00', end: '02:00' }], outsideBehavior: 'pause_all' }
const now = new Date('2026-09-07T19:00:00Z')
describe('queued analysis window guard', () => {
  it('re-reads current settings and bound account clock on each invocation', async () => {
    let enabled = false, reads = 0
    const pool = { async execute(_sql: string, parameters: unknown[]) {
      expect(parameters).toEqual([42, '7', '10', '11', 'XAUUSD'])
      return [[{ receive_timezone: 'terminal_server', receive_window_json: enabled ? window : { enabled: false } }]]
    } } as unknown as Pool
    const guard = new MysqlAnalysisWindowGuard(pool, async (accountId, userId) => {
      expect([accountId, userId]).toEqual(['7', 42]); reads += 1
      return { timezoneOffsetMinutes: 180, clockStatus: 'calibrated' }
    })
    await guard.assertAllowed(run, now)
    expect(reads).toBe(0)
    enabled = true
    await guard.assertAllowed(run, now)
    await expect(guard.assertAllowed(run, new Date('2026-09-07T23:00:00Z'))).rejects.toThrow('analysis_schedule_closed')
    expect(reads).toBe(2)
  })
  it('rejects removed subscription or lost account source and leaves manual requests outside this policy', async () => {
    let queries = 0
    const guard = new MysqlAnalysisWindowGuard({ async execute() { queries += 1; return [[]] } } as unknown as Pool, async () => null)
    await expect(guard.assertAllowed(run, now)).rejects.toThrow('analysis_schedule_closed')
    await expect(guard.assertAllowed({ ...run, marketSourceAccountId: null }, now)).rejects.toThrow('analysis_schedule_unavailable')
    await guard.assertAllowed({ ...run, trigger: 'manual' }, now)
    expect(queries).toBe(1)
  })
  it('retains signals-only with missing clock but never treats a display offset as calibrated', async () => {
    let outsideBehavior = 'pause_all'
    const guard = new MysqlAnalysisWindowGuard({ async execute() { return [[{
      receive_timezone: 'terminal_server', receive_window_json: { ...window, outsideBehavior },
    }]] } } as unknown as Pool, async () => ({ timezoneOffsetMinutes: 180, clockStatus: 'fallback' }))
    await expect(guard.assertAllowed(run, now)).rejects.toThrow('analysis_schedule_closed')
    outsideBehavior = 'signals_only'
    await expect(guard.assertAllowed(run, now)).resolves.toBeUndefined()
  })
})
