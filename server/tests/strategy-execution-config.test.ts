import { createHash } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'
import { sha256Canonical } from '../src/shared/canonical-json.js'
import { createStrategyExecutionConfigReader } from '../src/modules/strategies/composition.js'
import { compileStrategy } from '../src/modules/strategies/index.js'

const config = { risk_budget: { version: 1, max_risk_per_trade_percent: '0.5' }, entry_methods: ['market'] }
const prompt = 'Use structured evidence'
const promptHash = createHash('sha256').update(prompt).digest('hex')
const scope = { subscriptionId: '8', userId: 42, accountId: '7', subscriptionRevision: 3,
  traderStrategyId: '20', traderStrategyVersionId: '21', promptHash, configHash: sha256Canonical(config) }
const row = { strategy_id: '20', version_id: '21', prompt_text: prompt, prompt_sha256: promptHash, config_json: config }
function reader(rows: unknown[]) {
  const execute = vi.fn(async () => [rows])
  return { execute, port: createStrategyExecutionConfigReader({ execute } as unknown as PoolConnection) }
}

describe('trusted strategy execution configuration', () => {
  it('validates the same versioned budget at compilation before it becomes an immutable version', () => {
    expect(compileStrategy('trader', prompt, config).valid).toBe(true)
    for (const value of ['0', '-1', '100.000000000000000001', '1e-3', '01', '0.0000000000000000001', null, 0.5]) {
      expect(compileStrategy('trader', prompt, { risk_budget: { version: 1, max_risk_per_trade_percent: value } }).issues)
        .toContainEqual(expect.objectContaining({ code: 'strategy_risk_budget_invalid', level: 'error' }))
    }
    expect(compileStrategy('trader', prompt, {}).valid).toBe(true)
  })
  it('binds current authorized SQL scope to both frozen hashes and returns an isolated configuration', async () => {
    const { port, execute } = reader([row])
    const result = await port.read(scope)
    expect(result).toEqual({ strategyId: '20', versionId: '21', promptHash, configHash: scope.configHash, config })
    expect(execute.mock.calls[0]).toEqual([expect.stringContaining('FOR SHARE'), ['8', 42, '7', 3, '20', '21']])
    ;(result!.config.entry_methods as string[]).push('limit')
    expect(config.entry_methods).toEqual(['market'])
  })
  it('accepts serialized JSON and ignores key order without ignoring values', async () => {
    const reordered = { entry_methods: ['market'], risk_budget: { max_risk_per_trade_percent: '0.5', version: 1 } }
    expect(await reader([{ ...row, config_json: JSON.stringify(reordered) }]).port.read(scope)).not.toBeNull()
    expect(await reader([{ ...row, config_json: { ...config, entry_methods: ['limit'] } }]).port.read(scope)).toBeNull()
  })
  it('refuses absent or ambiguous authority and does not substitute current configuration for a missing frozen hash', async () => {
    expect(await reader([]).port.read(scope)).toBeNull()
    expect(await reader([row, row]).port.read(scope)).toBeNull()
    const { port, execute } = reader([row])
    expect(await port.read({ ...scope, configHash: '' })).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
  it.each([
    { strategy_id: '30' }, { version_id: '22' }, { prompt_text: 'Changed prompt' }, { prompt_sha256: '0'.repeat(64) },
    { config_json: 'broken JSON' }, { config_json: 'null' }, { config_json: '[]' },
    { config_json: { risk_budget: { version: 1, max_risk_per_trade_percent: '2' }, entry_methods: ['market'] } },
  ])('refuses mismatched or corrupt frozen source %j', async patch => {
    expect(await reader([{ ...row, ...patch }]).port.read(scope)).toBeNull()
  })
})
