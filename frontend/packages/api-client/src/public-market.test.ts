import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './index'

const response = () => ({ data: { symbol: 'XAUUSD', timeframe: 'M5', source_key: 'a'.repeat(64), source_generation: '1', status: 'cached',
  quote: { bid: '2500.00', ask: '2500.20', last: null, spread: '0.20', observed_at: '2026-09-14T00:00:00Z', revision: '1' }, candles: [], structure: null },
  meta: { request_id: 'public-snapshot', generated_at: '2026-09-14T00:00:00Z' } })

describe('public market consumer', () => {
  it('reads the same base-symbol catalog without an account parameter', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { items: ['XAUUSD'] }, meta: response().meta })))
    expect((await createApiClient({ fetchImpl }).getPublicMarketSymbols()).data.items).toEqual(['XAUUSD'])
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/market/public-symbols')
  })
  it('requests shared data without sending a trading account and preserves decimal strings', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response())))
    const client = createApiClient({ fetchImpl })
    expect((await client.getPublicMarketSnapshot('XAUUSD', 'M5')).data.quote?.bid).toBe('2500.00')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/market/public-snapshot?symbol=XAUUSD&timeframe=M5&page_size=200')
  })
  it('rejects accidental provider account disclosure in a public response', async () => {
    const body = response()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...body, data: { ...body.data, account_id: '20' } })))
    await expect(createApiClient({ fetchImpl }).getPublicMarketSnapshot('XAUUSD', 'M5')).rejects.toThrow()
  })
  it('rejects numeric price coercion', async () => {
    const body = response()
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...body, data: { ...body.data, quote: { ...body.data.quote, bid: 2500 } } })))
    await expect(createApiClient({ fetchImpl }).getPublicMarketSnapshot('XAUUSD', 'M5')).rejects.toThrow()
  })
})
