import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { beijingAfter, parseBeijing } from '../server/db.js'

describe('admin dispatch/position close lease time basis', () => {
  it('formats future leases as Beijing DATETIME and parses them independently of server TZ', () => {
    const before = Date.now()
    const value = beijingAfter(120_000)
    const parsed = parseBeijing(value)

    expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(parsed).not.toBeNull()
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before + 119_000)
    expect(parsed.getTime()).toBeLessThanOrEqual(Date.now() + 121_000)
  })

  it('uses the shared Beijing helper for every B1/B2 dispatch and target lease', () => {
    const files = [
      '../server/services/admin-strategy-trades.js',
      '../server/workers/admin-strategy-trade-worker.js',
      '../server/workers/admin-position-close-worker.js',
    ]
    for (const relative of files) {
      const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
      expect(source).toContain('beijingAfter')
      expect(source).not.toMatch(/new Date\(Date\.now\(\) \+.*lease/i)
    }
  })
})
