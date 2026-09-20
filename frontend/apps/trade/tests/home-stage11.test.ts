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
    const [realtime, workspace] = await Promise.all([source('trading-realtime.ts'), source('use-home-workspace.ts')])
    expect(realtime).toContain("from '@aurum/realtime'")
    expect(realtime).not.toMatch(/new\s+WebSocket/)
    expect(realtime).toContain("type: 'subscription.subscribe'")
    expect(realtime).toContain('RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]')
    expect(realtime).toMatch(/void resync\(\)\.then\([\s\S]*return connect\(/)
    expect(realtime).toContain("connection?.close(4000, 'revision_resync_required')")
    expect(realtime).toContain("resource_id: 'market_analyses'")
    expect(realtime).toContain('onAnalysisChanged?.()')
    expect(workspace).toContain('syncAccountSnapshot')
    expect(workspace).not.toContain('() => loadAccount(accountId, false')
  })

  it('keeps observer mode explicit across the selector, HTTP snapshot and realtime subscription', async () => {
    const [account, workspace, realtime] = await Promise.all([source('AccountSummaryCard.vue'), source('use-home-workspace.ts'), source('trading-realtime.ts')])
    expect(account).toContain('观摩模式')
    expect(account).toContain('退出观摩')
    expect(workspace).toContain('client.listObserverChannels()')
    expect(realtime).toContain('observer_channel_id: observerChannelId')
    expect(realtime).toContain('const accountTargets = !accountId ? [] : observerChannelId === null ?')
    expect(realtime).toContain("resource_id: 'metrics', after_revision: null")
    expect(realtime).toContain("type === 'observer.publication.changed'")
    expect(realtime).toContain('requestSnapshotResync()')
    expect(realtime).not.toContain("resource_id: 'bridge', after_revision: null },\n        { kind: 'account', trading_account_id: accountId, observer_channel_id: observerChannelId")
  })
})
