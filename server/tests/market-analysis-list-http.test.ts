import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { MarketAnalysisListService } from '../src/modules/inference/application/market-analysis-list.js'
import { inferenceRoutes, type InferenceRoutesOptions } from '../src/modules/inference/transport/http/inference-routes.js'

it('serves filtered pages with a scoped cursor and blocks malformed requests before the reader', async () => {
  const item = { id: 'a2', userId: 7, strategyId: '3', strategyVersionId: '4', symbol: 'XAUUSD.a', marketBias: 'bullish' as const,
    opportunity: 'none' as const, confidence: 75, summary: '等待', analyzedAt: '2026-09-09T00:00:00.000Z',
    validUntil: '2026-09-09T01:00:00.000Z', inputSnapshotHash: 'a'.repeat(64), revision: 1 }
  const createdAt = '2026-09-09T00:00:01.123Z'
  const readPage = vi.fn().mockResolvedValueOnce([{ item, createdAt }, { item: { ...item, id: 'a1' }, createdAt }])
    .mockResolvedValueOnce([{ item: { ...item, id: 'a1' }, createdAt }])
  const authenticate = vi.fn().mockResolvedValue({ userId: 7 })
  const app = Fastify()
  await app.register(inferenceRoutes, { prefix: '/api/v4', analysisList: new MarketAnalysisListService({ readPage }),
    service: {} as InferenceRoutesOptions['service'],
    auth: { authenticate, assertWrite: authenticate } })
  try {
    const path = '/api/v4/market-analyses?page_size=1&symbol=XAUUSD.a&strategy_id=3'
    const first = await app.inject(path)
    expect(first.statusCode).toBe(200); expect(first.headers['cache-control']).toBe('no-store')
    expect(first.json().data.items.map((value: { analysis_id: string }) => value.analysis_id)).toEqual(['a2'])
    const cursor = first.json().data.next_cursor
    expect(typeof cursor).toBe('string')
    const last = await app.inject(path + '&cursor=' + cursor)
    expect(last.statusCode).toBe(200); expect(last.json().data.next_cursor).toBeNull()
    expect(last.json().data.items[0].analysis_id).toBe('a1')
    expect(readPage).toHaveBeenLastCalledWith({ userId: 7, symbol: 'XAUUSD.a', strategyId: '3', limit: 2, after: { createdAt, id: 'a2' } })
    expect((await app.inject('/api/v4/market-analyses?cursor=' + cursor)).statusCode).toBe(400)
    expect((await app.inject(path + '&symbol=EURUSD')).statusCode).toBe(400)
    expect((await app.inject(path + '&actor=8')).statusCode).toBe(400)
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
    expect((await app.inject('/api/v4/market-analyses?page_size=bad')).statusCode).toBe(401)
    expect(readPage).toHaveBeenCalledTimes(2)
  } finally { await app.close() }
})
