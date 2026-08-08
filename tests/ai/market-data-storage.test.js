import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dbSource = readFileSync(new URL('../../server/db.js', import.meta.url), 'utf8')
const migrationSource = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')

describe('AI signal market data storage', () => {
  it('uses LONGTEXT for new databases and upgrades existing installations idempotently', () => {
    expect(dbSource).toContain('market_data_json LONGTEXT NOT NULL')
    expect(migrationSource).toContain("id: '151_expand_ai_signal_market_data'")
    expect(migrationSource).toContain("COLUMN_NAME = 'market_data_json'")
    expect(migrationSource).toContain("String(column.DATA_TYPE).toLowerCase() !== 'longtext'")
    expect(migrationSource).toContain('ALTER TABLE ai_signals MODIFY COLUMN market_data_json LONGTEXT NOT NULL')
  })

  it('covers the payload size that exceeded the previous TEXT limit', () => {
    const marketDataJson = JSON.stringify({ klines:'x'.repeat(128 * 1024) })
    expect(Buffer.byteLength(marketDataJson, 'utf8')).toBeGreaterThan(65_535)
    expect(Buffer.byteLength(marketDataJson, 'utf8')).toBeLessThan(4_294_967_295)
  })
})
