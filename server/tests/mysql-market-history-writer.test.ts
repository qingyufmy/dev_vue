import { expect, it, vi } from 'vitest'
const guard = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/modules/trading/infrastructure/mysql-trading-repository.js', () => ({ assertTerminalFactRoute: guard }))
import { MysqlMarketHistoryWriter } from '../src/modules/trading/infrastructure/mysql-market-history-writer.js'
const route = { accountId: '7' } as Parameters<MysqlMarketHistoryWriter['write']>[0]
const candle = { accountId: '7', symbol: 'XAUUSD.s', timeframe: 'M5' as const, openTime: '2026-09-14T00:00:00Z',
  open: '2500', high: '2501', low: '2499', close: '2500', tickVolume: '12', closed: true, revision: 10 }
function fixture() {
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), execute: vi.fn() }
  const pool = { getConnection: vi.fn(async () => connection) }
  return { connection, pool, writer: new MysqlMarketHistoryWriter(pool as never) }
}
it('rejects foreign or unclosed candles before obtaining a connection', async () => {
  const f = fixture()
  await expect(f.writer.write(route, [{ ...candle, accountId: '8' }])).rejects.toThrow('scope_invalid')
  await expect(f.writer.write(route, [{ ...candle, closed: false }])).rejects.toThrow('scope_invalid')
  expect(f.pool.getConnection).not.toHaveBeenCalled()
})
it('keeps route authorization locked in the page transaction and preserves decimal strings', async () => {
  const f = fixture(); guard.mockResolvedValueOnce(undefined)
  await f.writer.write(route, [candle])
  expect(guard).toHaveBeenCalledWith(f.connection, route)
  expect(f.connection.execute.mock.calls[0]![1]).toContain('2500')
  expect(f.connection.execute.mock.calls[0]![0]).toContain('IF(revision<VALUES(revision)')
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
it('does not write when the frozen terminal authorization is rejected', async () => {
  const f = fixture(); guard.mockRejectedValueOnce(new Error('revoked'))
  await expect(f.writer.write(route, [candle])).rejects.toThrow('revoked')
  expect(f.connection.execute).not.toHaveBeenCalled(); expect(f.connection.rollback).toHaveBeenCalledOnce()
})
