import { describe, expect, it } from 'vitest'
import { tradeHistorySummarySchema, browserRealtimeEventSchema, tradeHistoryPageResponseSchema, tradeRecordDetailResponseSchema } from './index'

const record = { account_currency: 'USD', currency_evidence: 'explicit_record', id: 'trade-1', account_id: '42', platform: 'mt5', primary_ticket: '1001', position_id: '9001', symbol: 'XAUUSD', side: 'buy', status: 'closed', source: 'system', attribution_status: 'exact', evidence_status: 'complete', volume: '0.10', entry_price: '2500.10', exit_price: '2510.10', stop_loss: null, take_profit: null, gross_profit: '100', commission: '-2', swap: '-1', fee: '0', net_profit: '97', opened_at: '2026-09-04T07:00:00.000Z', closed_at: '2026-09-04T07:30:00.000Z', terminal_timezone_offset_minutes: 180, revision: '1' }
const meta = { request_id: 'request-1', generated_at: '2026-09-04T08:00:00.000Z' }

describe('trade history contracts', () => {
  it('parses normalized records, summary and cumulative daily points', () => {
    const parsed = tradeHistoryPageResponseSchema.parse({ data: { captured_end: meta.generated_at, freshness: { status: 'ready', blocking_reason: null, history_revision: '8', fresh_through: meta.generated_at, last_success_at: meta.generated_at }, items: [record], next_cursor: null, has_more: false, summary: { account_currency: 'USD', money_status: 'comparable', trade_count: 1, winning_count: 1, losing_count: 0, breakeven_count: 0, win_rate_percent: '100', gross_profit: '100', commission: '-2', swap: '-1', fee: '0', net_profit: '97', profit_factor: null }, daily: [{ business_date: '2026-09-04', trade_count: 1, net_profit: '97', cumulative_net_profit: '97' }] }, meta })
    expect(parsed.data).toMatchObject({ capturedEnd: meta.generated_at, freshness: { historyRevision: 8 }, items: [{ primaryTicket: '1001', netProfit: '97' }], daily: [{ businessDate: '2026-09-04' }] })
  })

  it('keeps evidence links typed and rejects unproven source labels', () => {
    expect(tradeRecordDetailResponseSchema.safeParse({ data: { ...record, evidence_hash: 'a'.repeat(64), deals: [], attributions: [{ kind: 'trade_decision', source_id: 'decision-1', relation: 'opened', proof_kind: 'terminal_deal' }] }, meta }).success).toBe(true)
    expect(tradeRecordDetailResponseSchema.safeParse({ data: { ...record, source: 'probably_system', evidence_hash: 'a'.repeat(64), deals: [], attributions: [] }, meta }).success).toBe(false)
  })

  it('accepts a small history invalidation without requiring trade rows on websocket', () => {
    expect(browserRealtimeEventSchema.safeParse({ v: 4, event_id: 'event-1', type: 'trade.history.changed', occurred_at: meta.generated_at, sequence: 1, scope: { user_id: '7', trading_account_id: '42', terminal_instance_id: null, observer_channel_id: null }, resource: { kind: 'trade_history', id: '42' }, revision: '8', data: { status: 'ready', fresh_through: meta.generated_at }, correlation_id: null }).success).toBe(true)
  })
})

describe('money comparability contract', () => {
  const base = { account_currency: null, money_status: 'unknown', trade_count: 2, winning_count: 1, losing_count: 1, breakeven_count: 0, win_rate_percent: '50', gross_profit: null, commission: null, swap: null, fee: null, net_profit: null, profit_factor: null }
  it.each(['unknown', 'mixed'])('preserves unavailable amounts for %s', money_status => {
    expect(tradeHistorySummarySchema.parse({ ...base, money_status })).toMatchObject({ moneyStatus: money_status, accountCurrency: null, netProfit: null })
    expect(tradeHistorySummarySchema.safeParse({ ...base, money_status, net_profit: '0' }).success).toBe(false)
    expect(tradeHistorySummarySchema.safeParse({ ...base, money_status, account_currency: 'USD' }).success).toBe(false)
  })
  it('distinguishes an empty result from an unknown unit', () => {
    expect(tradeHistorySummarySchema.safeParse({ ...base, money_status: 'empty', trade_count: 0, winning_count: 0, losing_count: 0, win_rate_percent: null }).success).toBe(true)
    expect(tradeHistorySummarySchema.safeParse({ ...base, money_status: 'comparable' }).success).toBe(false)
  })
})
