import { describe, expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlTradeHistoryRepository } from '../src/modules/trade-history/infrastructure/mysql-trade-history-repository.js'

const filter = { accountId: '42', capturedEnd: '2026-09-04T12:00:00.000Z', limit: 1, cursor: { version: 1 as const, accountId: '42', filterKey: 'filter', capturedEnd: '2026-09-04T12:00:00.000Z', closedAt: '2026-09-04T09:00:00.000Z', id: 'page-2' } }

async function read(status: string, currency: string | null, dailyCurrency = currency) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const pool = { async execute(sql: string, params: unknown[]) {
    calls.push({ sql, params })
    if (sql.startsWith('WITH filtered')) return [[
      { business_date: '2026-09-03', trade_count: 1, net_profit: '0.1', account_currency: dailyCurrency },
      { business_date: '2026-09-04', trade_count: 1, net_profit: '0.2', account_currency: dailyCurrency },
    ], []]
    if (sql.includes('profit_factor')) return [[{ trade_count: status === 'empty' ? 0 : 2, winning_count: 2, losing_count: 0, breakeven_count: 0, win_rate_percent: '100',
      account_currency: currency, money_status: status, gross_profit: '0.3', commission: '0', swap_amount: '0', fee_amount: '0', net_profit: '0.3', profit_factor: '1' }], []]
    return [[], []]
  } } as unknown as Pool
  return { page: await new MysqlTradeHistoryRepository(pool).list(7, filter), calls }
}

it('reports an account with an active collection task as syncing even before records exist', async () => {
  const pool = { async execute(sql: string) {
    if (sql.includes('FROM (SELECT ? trading_account_id) scope')) return [[{
      status: 'syncing', blocking_reason: null, history_revision: 0, fresh_through_utc: null, last_success_at_utc: null,
    }], []]
    if (sql.includes('profit_factor')) return [[{ trade_count: 0, winning_count: 0, losing_count: 0, breakeven_count: 0,
      win_rate_percent: null, account_currency: null, money_status: 'empty', gross_profit: null, commission: null,
      swap_amount: null, fee_amount: null, net_profit: null, profit_factor: null }], []]
    return [[], []]
  } } as unknown as Pool
  const page = await new MysqlTradeHistoryRepository(pool).list(7, { ...filter, cursor: null })
  expect(page.freshness).toEqual({ status: 'syncing', blockingReason: null, historyRevision: 0, freshThrough: null, lastSuccessAt: null })
})

it('reports the terminal prerequisite that keeps an active task waiting', async () => {
  const pool = { async execute(sql: string, params: unknown[]) {
    if (sql.includes('FROM (SELECT ? trading_account_id) scope')) {
      expect(sql).toContain('account_runtime_snapshots')
      expect(sql).toContain('terminal_connection_unavailable')
      expect(params).toEqual(['42', '42', '42', '42', '42'])
      return [[{ status: 'syncing', blocking_reason: 'terminal_clock_unavailable', history_revision: 0,
        fresh_through_utc: null, last_success_at_utc: null }], []]
    }
    if (sql.includes('profit_factor')) return [[{ trade_count: 0, winning_count: 0, losing_count: 0, breakeven_count: 0,
      win_rate_percent: null, account_currency: null, money_status: 'empty', gross_profit: null, commission: null,
      swap_amount: null, fee_amount: null, net_profit: null, profit_factor: null }], []]
    return [[], []]
  } } as unknown as Pool
  const page = await new MysqlTradeHistoryRepository(pool).list(7, { ...filter, cursor: null })
  expect(page.freshness.blockingReason).toBe('terminal_clock_unavailable')
})

describe('history money query and adapter (offline SQL fixtures)', () => {
  it('adds same-unit daily values using decimals', async () => {
    const { page } = await read('comparable', 'USD')
    expect(page.summary).toMatchObject({ moneyStatus: 'comparable', accountCurrency: 'USD', netProfit: '0.3' })
    expect(page.daily.map(point => point.cumulativeNetProfit)).toEqual(['0.1', '0.3'])
  })

  it.each(['unknown', 'mixed', 'empty'])('does not turn %s money into zero or a cumulative curve', async status => {
    const { page } = await read(status, null)
    expect(page.summary).toMatchObject({ accountCurrency: null, moneyStatus: status, grossProfit: null, commission: null, swap: null, fee: null, netProfit: null, profitFactor: null })
    expect(page.daily.every(point => point.netProfit === null && point.cumulativeNetProfit === null)).toBe(true)
  })

  it('suppresses a curve whose independently read currency differs from the summary', async () => {
    const { page } = await read('comparable', 'USD', 'EUR')
    expect(page.daily.every(point => point.cumulativeNetProfit === null)).toBe(true)
  })

  it('checks the full authorized filter, not only the cursor page or individual day', async () => {
    const { calls } = await read('mixed', null)
    const page = calls.find(call => call.sql.includes('LIMIT ?'))!
    expect(page.params).toContain('page-2')
    for (const query of calls.filter(call => call.sql.includes('profit_factor') || call.sql.startsWith('WITH filtered'))) {
      expect(query.params).toEqual([7, '42', filter.capturedEnd])
      expect(query.sql).toContain('COUNT(DISTINCT r.account_currency)=1')
      expect(query.sql).toContain("r.currency_evidence='explicit_record'")
      expect(query.sql).toContain('r.ownership_interval_id IS NOT NULL')
      expect(query.sql).not.toContain('LIMIT ?')
    }
    expect(calls.find(call => call.sql.startsWith('WITH filtered'))!.sql).toContain('CROSS JOIN money_scope')
  })
})
