import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy } from '../src/modules/risk/domain/risk.js'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('AI trader single execution gate', () => {
  it('does not use the legacy send column to select executable subscriptions', async () => {
    const files = await Promise.all([
      source('../src/modules/execution/infrastructure/mysql-execution-window.ts'),
      source('../src/modules/execution/infrastructure/mysql-execution-distribution-repository.ts'),
      source('../src/modules/strategies/infrastructure/mysql-strategy-execution-config-reader.ts'),
    ])
    for (const contents of files) expect(contents).not.toMatch(/trade_send_enabled\s*=\s*1/)
  })

  it('keeps the legacy response field synchronized with the trader switch', async () => {
    const service = await source('../src/modules/strategies/application/strategy-service.ts')
    const catalog = await source('../src/modules/strategies/infrastructure/mysql-strategy-catalog.ts')
    expect(service).toContain('const tradeSendEnabled = traderEnabled')
    expect(catalog).toContain('tradeSendEnabled: Boolean(row.trader_enabled)')
  })

  it('ignores a persisted legacy account send preference', () => {
    const policy = resolveRiskPolicy({
      userId: 1, accountId: '2', platformPolicyVersionId: '3', accountPolicyVersionId: '4', policySetRevision: 1,
      platform: { values: DEFAULT_RISK_POLICY, globalKillSwitch: false, revision: 1 },
      account: { tradeSendEnabled: false }, updatedAt: new Date().toISOString(),
    })
    expect(policy.values.tradeSendEnabled).toBe(true)
    expect(policy.editableFields).not.toContain('tradeSendEnabled')
  })
})
