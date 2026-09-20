import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlRiskRepository } from '../src/modules/risk/infrastructure/mysql-risk-repository.js'
import type { EffectiveRiskPolicy, AccountRiskSummary } from '../src/modules/risk/index.js'

it('rejects unavailable current instrument facts without falling back to the raw table', async () => {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT d.id,d.user_id')) return [[{ id: 'decision-1', user_id: 7, trading_account_id: '11',
      decision_status: 'proposed', ownership_active: 1, subscription_active: 1, account_trade_permission: 1,
      subscription_trade_send_enabled: 1, standard_symbol: 'XAUUSD' }]]
    if (sql.startsWith('SELECT symbol,bid')) return [[{ symbol: 'XAUUSD' }]]
    return [[]]
  })
  const read = vi.fn().mockResolvedValue(null)
  const request = vi.fn().mockResolvedValue({ requestId: 'refresh', created: true })
  const repository = new MysqlRiskRepository({ execute } as unknown as Pool, () => { throw new Error('unexpected write') }, { read }, undefined, undefined, { request })
  vi.spyOn(repository, 'getEffectivePolicy').mockResolvedValue({ values: {} } as EffectiveRiskPolicy)
  vi.spyOn(repository, 'getAccountSummary').mockResolvedValue({} as AccountRiskSummary)
  await expect(repository.loadReviewCandidate('decision-1')).rejects.toThrow('risk_review_market_context_incomplete')
  expect(read).toHaveBeenCalledWith('11', 'XAUUSD')
  expect(request).toHaveBeenCalledWith({ userId: 7, accountId: '11', symbol: 'XAUUSD' })
  expect(execute.mock.calls.some(([sql]) => sql.startsWith('SELECT symbol,payload_json,revision FROM market_instrument_snapshots'))).toBe(false)
})
