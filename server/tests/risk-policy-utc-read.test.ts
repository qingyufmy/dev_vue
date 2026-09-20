import { describe, expect, it } from 'vitest'
import { riskUtcTime } from '../src/modules/risk/infrastructure/risk-sql-time.js'

describe('risk policy persisted UTC timestamp', () => {
  it('preserves MySQL wall time and fractional precision without local-zone interpretation', () => {
    expect(riskUtcTime('2026-09-11 10:11:12.123')).toBe('2026-09-11T10:11:12.123Z')
    expect(riskUtcTime('2026-09-11 10:11:12')).toBe('2026-09-11T10:11:12.000Z')
    expect(riskUtcTime('2026-09-11 10:11:12.1')).toBe('2026-09-11T10:11:12.100Z')
    expect(riskUtcTime(new Date('2026-09-11T10:11:12.123Z'))).toBe('2026-09-11T10:11:12.123Z')
  })
  it('rejects invalid calendar dates and ambiguous timestamps', () => {
    for (const value of ['2026-02-30 00:00:00', '2026-09-11T10:11:12', '2026-09-11 10:11:12+08:00', new Date(NaN)]) {
      expect(() => riskUtcTime(value)).toThrow('risk_timestamp_invalid')
    }
  })
})
