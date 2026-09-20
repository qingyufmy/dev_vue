import { describe, expect, it } from 'vitest'
import { reconstructReviewTrade } from '../src/modules/trade-history/domain/review-trade-lifecycle.js'

const base = { position_id: '100', symbol: 'XAUUSD', deal_kind: 'trade', volume: '0.01', price: '2500',
  account_currency: 'USD', currency_evidence: 'explicit_record', profit: '0', commission: '-0.10', swap: '0', fee: '0' }
const entry = { ...base, deal_ticket: '99', time_utc_msc: 1789000000000, entry_kind: 'in', side: 'buy' }
const exit = { ...base, deal_ticket: '100', time_utc_msc: 1789000010000, entry_kind: 'out', side: 'sell', profit: '1.00' }
describe('review closed lifecycle reconstruction', () => {
  it('reconstructs exact decimal volume and costs from both sides', () => {
    expect(reconstructReviewTrade('mt5', '100', [exit, entry])).toMatchObject({ volumeOpened: '0.01', volumeClosed: '0.01', commission: '-0.2', netProfit: '0.8' })
  })
  it('rejects partial, excess, reversed, mixed-position and duplicated fills', () => {
    for (const facts of [[entry], [entry, { ...exit, volume: '0.02' }], [entry, { ...exit, side: 'buy' }],
      [entry, { ...exit, position_id: '101' }], [entry, { ...exit, time_utc_msc: entry.time_utc_msc - 1 }],
      [entry, exit, exit], [{ ...entry, volume: '0' }, { ...exit, volume: '0' }]]) {
      expect(reconstructReviewTrade('mt5', '100', facts)).toBeNull()
    }
  })
  it('orders equal-time numeric tickets numerically', () => {
    expect(reconstructReviewTrade('mt5', '100', [{ ...exit, time_utc_msc: entry.time_utc_msc }, entry])).not.toBeNull()
  })
  it('includes exactly attributed late charges once and keeps adjustments separate', () => {
    const fee = { ...base, deal_ticket: '101', time_utc_msc: exit.time_utc_msc + 1000, deal_kind: 'fee', side: 'none', volume: '0',
      entry_kind: '', profit: '-0.30', commission: '0', fee: '-0.05' }
    expect(reconstructReviewTrade('mt5', '100', [entry, exit, fee])).toMatchObject({ grossProfit: '1', commission: '-0.2',
      fee: '-0.05', cashAdjustments: '-0.3', netProfit: '0.45', closedAtUtcMsc: exit.time_utc_msc })
    for (const invalid of [{ ...fee, position_id: null }, { ...fee, deal_kind: 'balance' }, { ...fee, volume: '0.01' },
      { ...fee, position_id: '101' }, { ...fee, time_utc_msc: entry.time_utc_msc - 1 }]) {
      expect(reconstructReviewTrade('mt5', '100', [entry, exit, invalid])).toBeNull()
    }
  })
})
