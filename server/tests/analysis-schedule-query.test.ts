import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlAnalysisScheduleRepository } from '../src/modules/inference/infrastructure/mysql-analysis-schedule-repository.js'

describe('analysis schedule query bounds', () => {
  it('rejects fractional and out-of-range limits before querying', async () => {
    let calls = 0
    const repo = new MysqlAnalysisScheduleRepository({ async execute() { calls += 1; return [[]] } } as unknown as Pool)
    for (const limit of [0, -1, 1.5, 501, NaN, Infinity]) await expect(repo.listDue('2026-09-07T00:00:00Z', limit)).rejects.toThrow('analysis_schedule_limit_invalid')
    expect(calls).toBe(0)
    await repo.listDue('2026-09-07T00:00:00Z', 500)
    expect(calls).toBe(1)
  })
})
