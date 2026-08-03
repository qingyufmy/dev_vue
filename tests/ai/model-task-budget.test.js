import { describe, expect, it } from 'vitest'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget } from '../../server/routes/ai/model-task-budget.js'

describe('model task adaptive budget', () => {
  it('treats the configured 30000 as a hard cap instead of a fixed request size', () => {
    const simple = selectModelTaskBudget({ taskKind:'auto_inference', profileHardCap:30000,
      estimatedInputTokens:5000, schemaNeedTokens:1200 })
    expect(simple.selectedMaxOutputTokens).toBe(2000)
    expect(simple.profileHardCap).toBe(30000)
    expect(simple.reason).toBe('task_floor')
  })

  it('allows a complex contract to grow to the profile hard cap', () => {
    const complex = selectModelTaskBudget({ taskKind:'auto_inference', profileHardCap:30000,
      providerOutputCap:64000, contextWindowTokens:128000, estimatedInputTokens:70000, schemaNeedTokens:30000 })
    expect(complex.selectedMaxOutputTokens).toBe(30000)
    expect(complex.sufficient).toBe(true)
  })

  it('fails closed when the complete output contract cannot fit in context', () => {
    const result = selectModelTaskBudget({ taskKind:'auto_inference', profileHardCap:30000,
      contextWindowTokens:32000, estimatedInputTokens:27000, schemaNeedTokens:8000 })
    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('output_budget_insufficient')
  })

  it('uses the smaller business deadline and keeps manual timeout as a tightening cap', () => {
    expect(modelTaskDeadlines('daily_review', {
      nowUtcMs:1000, manualAttemptMs:90_000, businessDeadlineUtcMs:200_000,
    })).toEqual({ attemptSafetyDeadlineUtcMs:91_000, taskDeadlineUtcMs:200_000 })
  })

  it('uses a conservative input estimate', () => {
    expect(estimateModelInputTokens('中'.repeat(3200))).toBe(1000)
  })
})
