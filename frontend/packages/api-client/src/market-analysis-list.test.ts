import { expect, it, vi } from 'vitest'
import { createApiClient } from './index'

it('sends the page cursor and exact filters and retains the next cursor', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    data: { items: [], next_cursor: 'next-page' }, meta: { request_id: 'r1', generated_at: '2026-09-09T00:00:00.000Z' },
  }), { status: 200 }))
  const client = createApiClient({ fetchImpl })
  const result = await client.listMarketAnalyses({ pageSize: 200, cursor: 'page-1', symbol: 'XAUUSD.a', strategyId: '3' })
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/market-analyses?page_size=200&cursor=page-1&symbol=XAUUSD.a&strategy_id=3')
  expect(result.data.nextCursor).toBe('next-page')
})
