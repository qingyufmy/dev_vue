import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { TradeHistorySummary } from '@aurum/contracts'
import TradeSummaryCards from '../components/TradeSummaryCards.vue'
import TradePnlChart from '../components/TradePnlChart.vue'

const charts = vi.hoisted(() => ({ setData: vi.fn(), remove: vi.fn(), create: vi.fn() }))
vi.mock('lightweight-charts', () => ({ ColorType: { Solid: 'solid' }, LineSeries: {}, createChart: (...args: unknown[]) => {
  charts.create(...args)
  return { addSeries: () => ({ setData: charts.setData }), timeScale: () => ({ fitContent() {} }), remove: charts.remove }
} }))
const summary: TradeHistorySummary = { accountCurrency: null, moneyStatus: 'unknown', tradeCount: 2, winningCount: 1, losingCount: 1, breakevenCount: 0, winRatePercent: '50', grossProfit: null, commission: null, swap: null, fee: null, netProfit: null, profitFactor: null }

describe('historical money display', () => {
  it('explains missing evidence and keeps the count without showing zero money', () => {
    const view = mount(TradeSummaryCards, { props: { summary, loading: false } })
    expect(view.text()).toContain('币种证据不足')
    expect(view.text()).not.toContain('0.00')
    expect(view.text()).not.toContain('USD')
    expect(view.text()).toContain('2')
    view.unmount()
  })

  it('creates and removes the chart when evidence becomes available or mixed', async () => {
    charts.create.mockClear(); charts.setData.mockClear(); charts.remove.mockClear()
    const points = [{ businessDate: '2026-09-04', tradeCount: 2, netProfit: null, cumulativeNetProfit: null }]
    const view = mount(TradePnlChart, { props: { summary, points } })
    expect(charts.create).not.toHaveBeenCalled()
    expect(view.text()).toContain('币种证据不足')
    await view.setProps({ summary: { ...summary, accountCurrency: 'EUR', moneyStatus: 'comparable', netProfit: '12' }, points: [{ ...points[0]!, netProfit: '12', cumulativeNetProfit: '12' }] })
    expect(charts.create).toHaveBeenCalledTimes(1)
    expect(charts.setData.mock.calls.at(-1)?.[0][0].value).toBe(12)
    expect(view.get('[role="img"]').attributes('aria-label')).toContain('EUR')
    await view.setProps({ summary: { ...summary, moneyStatus: 'mixed' }, points })
    expect(view.find('[role="img"]').exists()).toBe(false)
    expect(view.text()).toContain('包含不同币种')
    expect(charts.remove).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})
