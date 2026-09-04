import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const feature = (path: string) => readFile(resolve(process.cwd(), 'src/features/analyst', path), 'utf8')

describe('Stage 12L analyst vertical slice', () => {
  it('keeps history user-scoped and complete reasoning on HTTP', async () => {
    const [api, realtime, view] = await Promise.all([
      feature('api/analyst-api.ts'), feature('realtime/analyst-realtime.ts'), feature('views/AnalystView.vue'),
    ])
    expect(api).toContain('listMarketAnalyses')
    expect(api).toContain('getMarketAnalysis')
    expect(realtime).toContain("kind: 'signals'")
    expect(realtime).toContain("resource_id: 'all'")
    expect(realtime).toContain('trading_account_id: null')
    expect(view).toContain('AnalysisDetailPanel')
    expect(view).not.toContain('fetch(')
    expect(realtime).not.toMatch(/new\s+WebSocket/)
  })

  it('uses shadcn-vue composition for history, forms, states and full-screen reasoning', async () => {
    const files = await Promise.all([
      'components/AnalysisHistoryPanel.vue', 'components/AnalysisDetailPanel.vue',
      'components/ManualAnalysisSheet.vue', 'components/AnalysisFullScreenSheet.vue',
    ].map(feature))
    const source = files.join('\n')
    expect(source).toContain("from '@aurum/ui/card'")
    expect(source).toContain("from '@aurum/ui/sheet'")
    expect(source).toContain("from '@aurum/ui/progress'")
    expect(source).toContain("from '@aurum/ui/empty'")
    expect(source).not.toContain('<select')
    expect(source).not.toContain('<progress')
    expect(source).toContain('h-svh w-screen max-w-none')
  })

  it('places full reasoning after structured evidence and keeps list fields concise', async () => {
    const [detail, history] = await Promise.all([
      feature('components/AnalysisDetailPanel.vue'), feature('components/AnalysisHistoryPanel.vue'),
    ])
    expect(detail.indexOf('完整推理与分析正文')).toBeGreaterThan(detail.indexOf('判断依据'))
    expect(detail.indexOf('完整推理与分析正文')).toBeGreaterThan(detail.indexOf('数据缺口'))
    expect(history).toContain('strategyName(item.strategyId)')
    expect(history).toContain('opportunityLabel(item.opportunity)')
    expect(history).toContain('analysisTime(item.analyzedAt)')
    expect(history).not.toContain('item.summary')
  })

  it('keeps manual analysis one-shot, idempotent and server-cooled', async () => {
    const [api, workspace, sheet] = await Promise.all([
      feature('api/analyst-api.ts'), feature('composables/use-analyst-workspace.ts'), feature('components/ManualAnalysisSheet.vue'),
    ])
    expect(api).toContain('createManualAnalysis')
    expect(workspace).toContain('crypto.randomUUID()')
    expect(workspace).toContain('180_000')
    expect(sheet).toContain('手动分析不自动下单')
    expect(sheet).toContain('3 分钟冷却中')
  })
})
