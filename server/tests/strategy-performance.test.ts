import { describe, expect, it, vi } from 'vitest'
import { readStrategyDetail } from '../src/modules/strategies/infrastructure/mysql-strategy-catalog.js'

describe('strategy combination performance', () => {
  it('requires exact terminal lineage for both analysis and trader strategies', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{
        id: '5', kind: 'analysis', scope: 'platform', owner_user_id: null, name: '组合策略', description: '',
        status: 'active', active_version_id: '51', paired_trader_id: '8', paired_trader_name: '执行策略',
        paired_trader_status: 'active', paired_trader_active_version_id: '81', revision: 3,
      }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{
        account_currency: 'USD', trade_count: 4, winning_count: 3, net_profit: '120.50', gross_profit: '180.50',
        gross_loss: '60.00', max_drawdown: '25.00', period_start: new Date('2026-09-01T00:00:00.000Z'),
        period_end: new Date('2026-09-20T00:00:00.000Z'),
      }]])

    const detail = await readStrategyDetail({ execute } as never, 42, '5')
    expect(detail?.performance).toMatchObject({ status: 'available', currency: 'USD', tradeCount: 4,
      winRatePercent: '75.00', profitFactor: '3.0083', netProfit: '120.50', maxDrawdown: '25.00' })
    const [sql, params] = execute.mock.calls[2]!
    expect(sql).toContain("a.relation_kind='opened'")
    expect(sql).toContain('INNER JOIN market_analyses ma')
    expect(params).toEqual([42, '5', '8'])
  })
})
