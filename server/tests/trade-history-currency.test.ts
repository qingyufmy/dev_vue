import { describe, expect, it } from 'vitest'
import { decodeTerminalHistoryPage, projectMt4Trade, projectMt5Position } from '../src/modules/trade-history/index.js'

const now = Date.UTC(2026, 8, 4, 8)
const explicit = (currency: string) => ({ account_currency: currency, currency_evidence: 'explicit_record' })

function position(first: Record<string, unknown>, second: Record<string, unknown>) {
  const facts = decodeTerminalHistoryPage('deals', [
    { deal_ticket: '1001', position_id: '9001', symbol: 'XAUUSD', type: 0, entry: 0, volume: '0.1', price: '2500', profit: '0', commission: '-1', time_utc_msc: now - 60_000, ...first },
    { deal_ticket: '1002', position_id: '9001', symbol: 'XAUUSD', type: 1, entry: 1, volume: '0.1', price: '2510', profit: '100', commission: '-1', time_utc_msc: now, ...second },
  ])
  return projectMt5Position('9001', facts.filter(fact => fact.kind === 'deal'))
}

describe('historical money currency evidence', () => {
  it('does not infer a historical unit from an unqualified currency field', () => {
    expect(position({ account_currency: 'USD' }, { currency: 'USD' })).toMatchObject({ accountCurrency: null, currencyEvidence: 'unknown' })
  })

  it('preserves an explicitly shared record currency without changing monetary values', () => {
    expect(position(explicit('USC'), explicit('USC'))).toMatchObject({ accountCurrency: 'USC', currencyEvidence: 'explicit_record', evidenceStatus: 'complete', netProfit: '98' })
  })

  it('retains an unknown unit when even one constituent deal has no evidence', () => {
    expect(position(explicit('USD'), {})).toMatchObject({ accountCurrency: null, currencyEvidence: 'unknown' })
  })

  it('marks conflicting explicit units as conflicted rather than choosing one', () => {
    expect(position(explicit('USD'), explicit('EUR'))).toMatchObject({ accountCurrency: null, currencyEvidence: 'unknown', evidenceStatus: 'conflicted' })
  })

  it.each([{}, { account_currency: '' }, { account_currency: ' USD' }, { account_currency: 'USD '.repeat(5) }, { account_currency: 123 }])('rejects invalid explicit evidence %j', value => {
    expect(() => position({ currency_evidence: 'explicit_record', ...value }, {})).toThrow('trade_history_currency_evidence_invalid')
  })

  it('rejects unrecognized evidence provenance', () => {
    expect(() => position({ account_currency: 'USD', currency_evidence: 'current_account' }, {})).toThrow('trade_history_currency_evidence_invalid')
  })

  it.each([{}, explicit('EUR')])('preserves MT4 evidence and raw source independently %j', evidence => {
    const raw = { ticket: '7001', symbol: 'EURUSD', type: 1, lots: '0.2', open_price: '1.1', close_price: '1.09', profit: '200', commission: '-4', swap: '-1', open_time_utc_msc: now - 120_000, close_time_utc_msc: now, ...evidence }
    const fact = decodeTerminalHistoryPage('mt4_closed_trades', [raw])[0]!
    if (fact.kind !== 'deal') throw new Error('expected_deal')
    expect(JSON.parse(fact.evidenceJson)).toEqual(raw)
    expect(projectMt4Trade(fact)).toMatchObject({ accountCurrency: 'account_currency' in evidence ? 'EUR' : null, currencyEvidence: 'currency_evidence' in evidence ? 'explicit_record' : 'unknown', netProfit: '195' })
  })
})
