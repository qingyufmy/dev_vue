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

  it('uses shadcn-vue form primitives and requires a fresh compile before saving', () => {
    const source = featureFile('components/StrategyEditorSheet.vue')
    expect(source).toContain('<Sheet :open="open"')
    expect(source).toContain('<Textarea id="strategy-prompt"')
    expect(source).toContain('<FieldGroup')
    expect(source).toContain('compiledSignature.value !== signature(draft.value)')
    expect(source).toContain('策略与平台安全边界彼此独立')
  })

  it('shows account-specific trader and trade-send controls without moving risk logic to the browser', () => {
    const source = featureFile('components/SubscriptionEditorSheet.vue')
    expect(source).toContain('启用 AI 交易员')
    expect(source).toContain('允许发送交易')
    expect(source).toContain('仍必须通过账户风控与执行校验')
    expect(source).toContain('自动分析固定每 5 分钟调度')
  })

  it('keeps platform strategies read-only and uses immutable versions', () => {
    const source = featureFile('components/StrategyDetail.vue')
    expect(source).toContain("detail.strategy.scope === 'user'")
    expect(source).toContain('历史版本不可覆盖')
    expect(source).toContain('发布此版')
    expect(source).toContain('退役策略')
  })
})
