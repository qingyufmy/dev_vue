import { describe, expect, it } from 'vitest'
import { strategyMemoryBudget } from '../src/modules/inference/domain/strategy-memory-budget.js'

describe('named strategy memory token estimate', () => {
  it('counts UTF-8 bytes and rounds the legacy estimate upward', () => {
    expect(strategyMemoryBudget('中文A', 2)).toEqual({ method: 'utf8_bytes_div4_v1', contentBytes: 7, estimatedTokens: 2, maxTokens: 2 })
    expect(strategyMemoryBudget('12345', 2).estimatedTokens).toBe(2)
    expect(strategyMemoryBudget('', 1).estimatedTokens).toBe(0)
  })
  it('accepts the boundary and rejects overflow without truncating', () => {
    expect(strategyMemoryBudget('a'.repeat(3200), 800).estimatedTokens).toBe(800)
    expect(() => strategyMemoryBudget('a'.repeat(3201), 800)).toThrowError(expect.objectContaining({ code: 'strategy_memory_budget_exceeded' }))
  })
  it('rejects absent or non-integral budgets', () => {
    for (const budget of [0, -1, 1.5, NaN, Infinity]) expect(() => strategyMemoryBudget('text', budget)).toThrow()
  })
})
