import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(resolve(process.cwd(), 'src/features/home', path), 'utf8')

describe('Stage 11 trade home composition', () => {
  it('uses shared shadcn-vue components instead of a hand-built widget system', async () => {
    const files = await Promise.all(['HomeView.vue', 'AccountSummaryCard.vue', 'MarketWorkspaceCard.vue', 'TradingResourcesCard.vue'].map(source))
    expect(files.join('\n')).toContain("from '@aurum/ui/select'")
    expect(files.join('\n')).toContain("from '@aurum/ui/tabs'")
    expect(files.join('\n')).toContain("from '@aurum/ui/table'")
    expect(files.join('\n')).not.toContain('<select')
    expect(files.join('\n')).not.toContain('<table')
  })

  it('loads one HTTP history snapshot then updates only the newest candle and volume bar', async () => {
    const chart = await source('TradingChart.vue')
    expect(chart).toContain('candleSeries.setData(items.map(candleData))')
    expect(chart).toContain('candleSeries.update(candleData(latest))')
    expect(chart).toContain('volumeSeries.update(volumeData(latest))')
    expect(chart).toContain('historyVersion')
  })

  it('keeps browser WebSocket creation outside the application package', async () => {
    const realtime = await source('trading-realtime.ts')
    expect(realtime).toContain("from '@aurum/realtime'")
    expect(realtime).not.toMatch(/new\s+WebSocket/)
    expect(realtime).toContain("type: 'subscription.subscribe'")
  })

  it('keeps observer mode explicit across the selector, HTTP snapshot and realtime subscription', async () => {
    const [account, workspace, realtime] = await Promise.all([source('AccountSummaryCard.vue'), source('use-home-workspace.ts'), source('trading-realtime.ts')])
    expect(account).toContain('观摩模式')
    expect(account).toContain('退出观摩')
    expect(workspace).toContain('client.listObserverChannels()')
    expect(workspace).toContain('client.enterObserverMode')
    expect(workspace).toContain('client.leaveObserverMode')
    expect(realtime).toContain('observer_channel_id: observerChannelId')
  })
})
