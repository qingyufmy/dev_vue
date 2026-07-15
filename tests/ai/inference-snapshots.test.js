import { describe, expect, it, vi } from 'vitest'
import {
  buildSharedMarketSnapshot,
  prepareInferenceSnapshot,
  persistInferenceSnapshotTx,
  sanitizeInferenceEvidence,
} from '../../server/routes/ai/inference-snapshots.js'

describe('shared market inference boundary', () => {
  it('is invariant to administrator account and inventory changes', () => {
    const base = {
      symbol: 'XAUUSD.a', timeframe: 'M5', latest_price: 2400, atr_14: 12,
      strategy_context: { timeframes: { M5: { klines: [[1, 2, 3, 1, 2, 8]], summary: { pending_orders: [{ ticket: 1 }], rsi_14: 50 } } } },
    }
    const first = buildSharedMarketSnapshot({ ...base, account: { balance: 1 }, positions: { total_positions: 8 }, pending_orders: [{ ticket: 1 }] }, { volumeMin: 0.01, volumeMax: 0.05 })
    const second = buildSharedMarketSnapshot({ ...base, account: { balance: 999999 }, positions: { total_positions: 0 }, pending_orders: [] }, { volumeMin: 0.01, volumeMax: 0.05 })
    expect(first).toEqual(second)
    expect(first.standard_symbol).toBe('XAUUSD')
    expect(first).not.toHaveProperty('account')
    expect(first).not.toHaveProperty('positions')
    expect(first).not.toHaveProperty('pending_orders')
    expect(first.strategy_context.timeframes.M5.summary).toEqual({ rsi_14: 50 })
  })
})

describe('inference snapshot evidence', () => {
  it('recursively strips credentials and Authorization headers', () => {
    const clean = sanitizeInferenceEvidence({ api_key: 'x', nested: { Authorization: 'Bearer y', price: 1 }, access_token: 'z' })
    expect(clean).toEqual({ nested: { price: 1 } })
  })

  it('marks oversized evidence incomplete with explicit omissions and stable hashes', () => {
    const input = {
      systemPrompt: 'system', userPrompt: 'x'.repeat(5000), marketSnapshot: { strategy_context: { timeframes: { M5: { klines: Array.from({ length: 200 }, (_, i) => [i, 1, 2, 0, 1, 3]) } } } },
      strategyId: 1, strategyScope: 'platform', standardSymbol: 'XAUUSD', marketSource: 'platform_market_bridge', outputSchemaVersion: 'a'.repeat(64), credentialSource: 'platform_primary',
    }
    const result = prepareInferenceSnapshot(input, 1800)
    expect(result.evidenceStatus).toBe('incomplete')
    expect(result.omittedFields.length).toBeGreaterThan(0)
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.byteSize).toBeLessThanOrEqual(1800)
  })

  it('persists metadata without any model secret column or value', async () => {
    const run = vi.fn().mockResolvedValue([{ insertId: 7 }])
    const id = await persistInferenceSnapshotTx(run, {
      signalId: 2, strategyId: 3, strategyVersion: 4, strategyScope: 'private', ownerUserId: 9,
      standardSymbol: 'EURUSD', marketSource: 'owner_mt5_bridge', systemPrompt: 's', userPrompt: 'u',
      outputSchemaVersion: 'b'.repeat(64), marketSnapshot: { price: 1 }, modelProfileId: 5,
      provider: 'deepseek', modelName: 'chat', credentialSource: 'user', memoryMode: 'off',
    })
    expect(id).toBe(7)
    expect(run.mock.calls[0][0]).not.toMatch(/api_key|authorization/i)
    expect(JSON.stringify(run.mock.calls[0][1])).not.toContain('Bearer')
  })
})
