import { expect, it } from 'vitest'
import { accountHistoryMetrics } from '../src/modules/trade-history/domain/account-history-metrics.js'
import { decodeTerminalHistoryPage, type TerminalDealFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'

const dayStart = Date.UTC(2026, 8, 15), observed = dayStart + 60000
function fact(ticket: number, type: number, profit: string, extra = {}) {
  return decodeTerminalHistoryPage('deals', [{ ticket: String(ticket), type, profit, commission: '0', swap: '0', fee: '0',
    time_msc: dayStart + ticket * 1000, ...extra }])[0] as TerminalDealFact
}
const deposit = fact(1, 2, '1000')
const entry = fact(2, 0, '0', { entry: 0, position_id: '10', order: '20', symbol: 'XAUUSD', volume: '0.01', price: '2000' })
const exit = fact(3, 1, '-10', { entry: 1, position_id: '10', order: '21', symbol: 'XAUUSD', volume: '0.01', price: '1990' })
const run = (facts = [deposit, entry, exit], balance = '990') => accountHistoryMetrics({ facts, balance, dayStart, observed, positions: [], lossLimit: 1, cooldownMinutes: 60 })
it('separates capital from realized loss and derives closed-position loss cooldown', () => {
  expect(run()).toMatchObject({ realizedNet: '-10.00000000', netCapitalFlow: '1000.00000000', dailyOpenCount: 1, consecutiveLosses: 1,
    cooldownUntil: new Date(dayStart + 3000 + 3600000).toISOString() })
})
it('refuses an incomplete history tail even when its pages were complete', () => {
  expect(() => run([deposit, entry], '990')).toThrow('risk_history_balance_mismatch')
})
it('refuses history that contradicts live positions', () => {
  expect(() => run([deposit, entry], '1000')).toThrow('risk_history_inventory_mismatch')
})
it('does not treat unknown capital events as trading profit', () => {
  expect(() => run([fact(1, 3, '1000')], '1000')).toThrow('risk_history_kind_unresolved')
})
it('rejects duplicate facts rather than double counting cash', () => {
  expect(() => run([deposit, deposit])).toThrow('risk_history_fact_invalid')
})
