import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const feature = (path: string) => readFileSync(resolve(process.cwd(), 'src/features/trades', path), 'utf8')

describe('trade history workspace', () => {
  it('uses shadcn-vue primitives for filters, table, states and detail disclosure', () => {
    const filters = feature('components/TradeHistoryFilters.vue')
    const table = feature('components/TradeHistoryTable.vue')
    const detail = feature('components/TradeDetailSheet.vue')
    expect(filters).toContain("from '@aurum/ui/select'")
    expect(filters).toContain("from '@aurum/ui/field'")
    expect(table).toContain('<Table>')
    expect(table).toContain('<Empty')
    expect(detail).toContain('<Sheet')
    expect(detail).toContain('<ScrollArea')
    expect(detail).toContain('决策与执行链路')
  })

  it('keeps account summary and chart ahead of the detailed trade list', () => {
    const view = feature('views/TradesView.vue')
    expect(view.indexOf('<TradeSummaryCards')).toBeLessThan(view.indexOf('<TradePnlChart'))
    expect(view.indexOf('<TradePnlChart')).toBeLessThan(view.indexOf('<TradeHistoryTable'))
    expect(view).toContain('终端历史证据为准')
    expect(view).toContain(':freshness-status="workspace.freshness.value.status"')
    expect(view).toContain(':has-filters="hasFilters"')
  })

  it('provides a mobile record surface and terminal-time context', () => {
    const table = feature('components/TradeHistoryTable.vue')
    expect(table).toContain('lg:hidden')
    expect(table).toContain('terminalTime(')
    expect(table).toContain("emit('select'")
    expect(table).toContain('min-h-24')
  })

  it('subscribes only to lightweight account history invalidations', () => {
    const realtime = feature('realtime/trade-history-realtime.ts')
    expect(realtime).toContain("kind: 'trades'")
    expect(realtime).toContain("resource_id: 'history'")
    expect(realtime).toContain("parsed.data.type === 'trade.history.changed'")
    expect(realtime).not.toContain('items:')
  })
})
