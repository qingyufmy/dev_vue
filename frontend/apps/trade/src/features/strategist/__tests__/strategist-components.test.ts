import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const featureFile = (path: string) => readFileSync(resolve(process.cwd(), 'src/features/strategist', path), 'utf8')

describe('strategist workspace components', () => {
  it('keeps the strategy library and account subscriptions as separate primary tasks', () => {
    const view = featureFile('views/StrategistView.vue')
    expect(view).toContain('value="library"')
    expect(view).toContain('value="subscriptions"')
    expect(view).toContain('<StrategyCatalog')
    expect(view).toContain('<SubscriptionWorkspace')
  })

  it('uses the AI trader as the single automation switch while keeping risk on the server', () => {
    const editor = featureFile('components/SubscriptionEditorSheet.vue')
    const trader = featureFile('components/SubscriptionTraderFields.vue')
    expect(trader).toContain('发送通过账户权限与服务端风控的交易动作')
    expect(editor).not.toContain('trade-send-enabled')
    expect(editor).not.toContain('允许发送交易')
    expect(editor).toContain('自动分析按策略运行间隔调度')
    expect(trader).toContain('自动绑定')
    expect(trader).not.toContain('SelectTrigger')
  })

  it('presents analysis and execution as one customer-facing strategy combination with evidence metrics', () => {
    const catalog = featureFile('components/StrategyCatalog.vue')
    const detail = featureFile('components/StrategyDetail.vue')
    expect(catalog).toContain('策略组合')
    expect(catalog).not.toContain('TabsTrigger')
    expect(detail).toContain('平台实盘效果')
    expect(detail).toContain('所有用户和账户')
    expect(detail).toContain('精确归因')
    expect(detail).toContain('最大回撤')
    expect(detail).toContain('盈亏比')
  })

  it('keeps platform strategies read-only and uses immutable versions', () => {
    const source = featureFile('components/StrategyDetail.vue')
    expect(source).toContain("detail.strategy.scope === 'user'")
    expect(source).toContain('历史版本不可覆盖')
    expect(source).toContain('发布此版')
    expect(source).toContain('退役策略')
  })
})
