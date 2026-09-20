import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlTradingRepository } from '../src/modules/trading/infrastructure/mysql-trading-repository.js'

describe('market candle query limits', () => {
  it.each([1, 30, 150, 1000, 1400, 1600, 1800, 2000])('binds validated limit %i as MySQL-compatible decimal text', async limit => {
    const db = { execute: vi.fn().mockResolvedValue([[]]) }
    await new MysqlTradingRepository(db as unknown as Pool).listCandles('7', 'XAUUSD', 'M1', limit)
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('ORDER BY open_time_utc DESC LIMIT ?'), ['7', 'XAUUSD', 'M1', String(limit)])
  })
  it.each([0, -1, 1.5, NaN, Infinity, 2001])('rejects invalid limit %s before querying', async limit => {
    const db = { execute: vi.fn() }
    await expect(new MysqlTradingRepository(db as unknown as Pool).listCandles('7', 'XAUUSD', 'M1', limit)).rejects.toThrow('market_candle_limit_invalid')
    expect(db.execute).not.toHaveBeenCalled()
  })
})
