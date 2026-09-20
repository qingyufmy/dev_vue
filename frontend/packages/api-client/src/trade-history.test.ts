import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './index'

describe('trade history API client', () => {
  it('encodes stable filters and detail ids on normalized V4 routes', async () => {
    const meta = { request_id: 'request-1', generated_at: '2026-09-04T08:00:00.000Z' }
    const responses = [
      { data: { captured_end: meta.generated_at, freshness: { status: 'empty', blocking_reason: null, history_revision: '0', fresh_through: null, last_success_at: null }, items: [], next_cursor: null, has_more: false, summary: { account_currency: null, money_status: 'empty', trade_count: 0, winning_count: 0, losing_count: 0, breakeven_count: 0, win_rate_percent: null, gross_profit: null, commission: null, swap: null, fee: null, net_profit: null, profit_factor: null }, daily: [] }, meta },
      { data: { account_currency: null, currency_evidence: 'unknown', id: 'trade/1', account_id: '42', platform: 'mt5', primary_ticket: '1001', position_id: null, symbol: 'XAUUSD', side: 'buy', status: 'closed', source: 'unknown', attribution_status: 'unresolved', evidence_status: 'partial', volume: '0.10', entry_price: '2500', exit_price: '2510', stop_loss: null, take_profit: null, gross_profit: '10', commission: '0', swap: '0', fee: '0', net_profit: '10', opened_at: '2026-09-04T07:00:00.000Z', closed_at: '2026-09-04T07:30:00.000Z', terminal_timezone_offset_minutes: 180, revision: '1', evidence_hash: 'a'.repeat(64), deals: [], attributions: [] }, meta },
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }))
    const client = createApiClient({ fetchImpl })
    await client.listTradeHistory({ accountId: 'account/1', symbol: 'XAUUSD', side: 'buy', source: 'system', outcome: 'profit', fromDate: '2026-09-01', toDate: '2026-09-04', query: '1001', pageSize: 25, cursor: 'cursor/1' })
    await client.getTradeRecord('trade/1')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v4/trade-history?account_id=account%2F1&page_size=25&symbol=XAUUSD&side=buy&source=system&outcome=profit&from_date=2026-09-01&to_date=2026-09-04&q=1001&cursor=cursor%2F1')
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v4/trade-history/trade%2F1')
  })
})
