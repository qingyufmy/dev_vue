import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MarketAnalysisListService } from '../src/modules/inference/application/market-analysis-list.js'
import type { MarketAnalysisSummary } from '../src/modules/inference/domain/inference.js'
import { MysqlMarketAnalysisListReader } from '../src/modules/inference/infrastructure/mysql-market-analysis-list-reader.js'

const createdAt = '2026-09-09T00:00:00.123Z'
const row = (id: string) => ({ createdAt, item: { id, userId: 7, symbol: 'XAUUSD.a', strategyId: '3',
  analyzedAt: '2026-09-08T23:59:00.000Z' } as MarketAnalysisSummary })
it('uses one extra row and resumes from the last returned creation-time/id key', async () => {
  const readPage = vi.fn().mockResolvedValueOnce([row('a3'), row('a2'), row('a1')]).mockResolvedValueOnce([row('a1')])
  const service = new MarketAnalysisListService({ readPage })
  const query = { pageSize: '2', symbol: 'XAUUSD.a', strategyId: '3' }
  const first = await service.list(7, query)
  expect(first.items.map(item => item.id)).toEqual(['a3', 'a2'])
  const second = await service.list(7, { ...query, cursor: first.nextCursor })
  expect(readPage).toHaveBeenLastCalledWith({ userId: 7, symbol: 'XAUUSD.a', strategyId: '3', limit: 3,
    after: { createdAt, id: 'a2' } })
  expect(second.items.map(item => item.id)).toEqual(['a1']); expect(second.nextCursor).toBeNull()
})
it('rejects malformed and cross-scope cursors before any data read', async () => {
  const readPage = vi.fn().mockResolvedValue([row('a2'), row('a1')])
  const service = new MarketAnalysisListService({ readPage })
  const first = await service.list(7, { pageSize: 1, symbol: 'XAUUSD.a' })
  readPage.mockClear()
  for (const [userId, query] of [[8, { cursor: first.nextCursor, symbol: 'XAUUSD.a' }],
    [7, { cursor: first.nextCursor, symbol: 'EURUSD' }], [7, { cursor: first.nextCursor, symbol: 'XAUUSD.a', strategyId: '3' }],
    [7, { cursor: 'not-json' }], [7, { pageSize: '1e2' }], [7, { pageSize: 201 }], [7, { pageSize: 1.5 }]] as const) {
    await expect(service.list(userId, query)).rejects.toMatchObject({ code: 'analysis_list_request_invalid' })
  }
  expect(readPage).not.toHaveBeenCalled()
})
it('returns no cursor for empty data and rejects out-of-scope reader results', async () => {
  const readPage = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row('a1')])
  const service = new MarketAnalysisListService({ readPage })
  expect(await service.list(7)).toEqual({ items: [], nextCursor: null })
  await expect(service.list(8)).rejects.toMatchObject({ code: 'analysis_list_response_invalid' })
})
it('binds owner, exact symbol, strategy and stable page key without reading large payloads', async () => {
  const execute = vi.fn().mockResolvedValue([[]])
  const reader = new MysqlMarketAnalysisListReader({ execute } as unknown as Pool)
  await reader.readPage({ userId: 7, symbol: 'XAUUSD.a', strategyId: '3', limit: 3, after: { createdAt, id: 'a2' } })
  const [sql, params] = execute.mock.calls[0]!
  expect(sql).toContain('a.owner_user_id=? AND BINARY a.standard_symbol=BINARY ? AND a.strategy_id=?')
  expect(sql).toContain('(a.created_at_utc<? OR (a.created_at_utc=? AND a.id<?))')
  expect(sql).toContain('ORDER BY a.created_at_utc DESC,a.id DESC LIMIT ?')
  expect(sql).not.toMatch(/SELECT\s+\*|payload_json|OFFSET/i)
  expect(params).toEqual([7, 'XAUUSD.a', '3', '2026-09-09 00:00:00.123', '2026-09-09 00:00:00.123', 'a2', '3'])
})
