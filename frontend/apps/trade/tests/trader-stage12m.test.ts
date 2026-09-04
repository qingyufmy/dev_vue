import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const feature = (path: string) => readFile(resolve(process.cwd(), 'src/features/trader', path), 'utf8')

describe('Stage 12M trader read workspace', () => {
  it('uses account-scoped HTTP reads and explicit realtime resources', async () => {
    const [api, realtime, workspace] = await Promise.all([
      feature('api/trader-api.ts'),
      feature('realtime/trader-realtime.ts'),
      feature('composables/use-trader-workspace.ts'),
    ])

    expect(api).toContain('listTradeDecisions')
    expect(api).toContain('getTradeDecision')
    expect(realtime).toContain("resource_id: 'trade_decisions'")
    expect(realtime).toContain("kind: 'operations'")
    expect(realtime).toContain("resource_id: 'positions'")
    expect(realtime).toContain("resource_id: 'pending_orders'")
    expect(workspace).toContain('observerId ? Promise.resolve(null)')
    expect(workspace).toContain('queuedAccountId')
    expect(workspace).toContain('Promise.allSettled')
    expect(workspace).not.toContain('fetch(')
    expect(realtime).not.toMatch(/new\s+WebSocket/)
  })

  it('composes shadcn-vue resources, details and decision panels', async () => {
    const source = (await Promise.all([
      'components/TraderAccountSummary.vue',
      'components/InventoryWorkspace.vue',
      'components/InventoryDetailSheet.vue',
      'components/TraderDecisionHistory.vue',
      'components/TraderDecisionDetail.vue',
    ].map(feature))).join('\n')

    expect(source).toContain("from '@aurum/ui/card'")
    expect(source).toContain("from '@aurum/ui/table'")
    expect(source).toContain("from '@aurum/ui/sheet'")
    expect(source).toContain("from '@aurum/ui/tabs'")
    expect(source).toContain("from '@aurum/ui/empty'")
    expect(source).not.toContain('<table')
    expect(source).not.toContain('<select')
    expect(source).not.toContain('v-html')
  })

  it('routes supported V4 commands through context, confirmation and operation state', async () => {
    const files = await Promise.all([
      feature('views/TraderView.vue'),
      feature('components/InventoryWorkspace.vue'),
      feature('components/InventoryDetailSheet.vue'),
      feature('components/TraderDangerConfirm.vue'),
      feature('composables/use-trader-commands.ts'),
      feature('model/trader-command-builder.ts'),
    ])
    const source = files.join('\n')

    expect(source).toContain('prepareCommand')
    expect(source).toContain('expected_state')
    expect(source).toContain('TraderDangerConfirm')
    expect(source).toContain('HTTP 接受不等于终端成交')
    expect(source).toContain('handleOperationChanged')
    expect(source).not.toContain('操作成功')
    expect(source).not.toContain('/api/v3')
  })

  it('keeps full reasoning below structured actions and refuses guessed signal links', async () => {
    const [detail, resource] = await Promise.all([
      feature('components/TraderDecisionDetail.vue'),
      feature('components/InventoryDetailSheet.vue'),
    ])

    expect(detail.indexOf('完整推理')).toBeGreaterThan(detail.indexOf('拟执行动作'))
    expect(resource).toContain('系统不会根据相似编号猜测关联记录')
    expect(resource).not.toMatch(/analysis_id:\s*resource\.signalId/)
  })
})
