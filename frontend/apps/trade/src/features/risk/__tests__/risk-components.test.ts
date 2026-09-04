import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const featureFile = (path: string) => readFileSync(resolve(process.cwd(), 'src/features/risk', path), 'utf8')

describe('risk workspace components', () => {
  it('uses shadcn-vue primitives and progressive disclosure for editable policy fields', () => {
    const source = featureFile('components/RiskPolicyEditorSheet.vue')
    expect(source).toContain('<Sheet :open="open"')
    expect(source).toContain('<SheetTitle>')
    expect(source).toContain('<FieldGroup')
    expect(source).toContain('<Tabs')
    expect(source).toContain('<Switch')
    expect(source).toContain('平台边界')
    expect(source).toContain('修改原因')
  })

  it('requires explicit acknowledgement before a manual release', () => {
    const source = featureFile('components/ManualReleaseDialog.vue')
    expect(source).toContain('<AlertDialog :open="open"')
    expect(source).toContain('我已核对当前账户风险')
    expect(source).toContain('平台硬限制')
    expect(source).toContain('风险继续恶化会自动失效')
    expect(source).toContain('<Checkbox')
  })

  it('keeps the critical state first and supports responsive decision inspection', () => {
    const view = featureFile('views/RiskView.vue')
    const history = featureFile('components/RiskDecisionHistory.vue')
    expect(view.indexOf('<RiskStateCard')).toBeLessThan(view.indexOf('<RiskMetricsGrid'))
    expect(view.indexOf('<RiskMetricsGrid')).toBeLessThan(view.indexOf('<RiskDecisionHistory'))
    expect(history).toContain('<Table>')
    expect(history).toContain('md:hidden')
    expect(history).toContain("emit('inspect'")
  })

  it('subscribes only to account-scoped V4 risk resources and resyncs on gaps', () => {
    const source = featureFile('realtime/risk-realtime.ts')
    expect(source).toContain("kind: 'risk'")
    expect(source).toContain("resource_id: 'all'")
    expect(source).toContain("event.scope.trading_account_id !== input.accountId")
    expect(source).toContain('risk_sequence_gap')
    expect(source).toContain('input.resync()')
  })
})
