import { describe, expect, it } from 'vitest'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget,
  summarizeModelOutputHistory } from '../../server/routes/ai/model-task-budget.js'

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
    expect(complex.contextWindowTokens).toBe(128000)
  })

  it('does not impose a hidden 30000 ceiling above the database profile hard cap', () => {
    const complex = selectModelTaskBudget({ taskKind:'monthly_review_merge', profileHardCap:50000,
      providerOutputCap:64000, contextWindowTokens:160000, estimatedInputTokens:70000, schemaNeedTokens:42000 })
    expect(complex.selectedMaxOutputTokens).toBe(42000)
    expect(complex.profileHardCap).toBe(50000)
    expect(complex.taskCap).toBeNull()
    expect(complex.sufficient).toBe(true)
  })

  it('fails closed when the complete output contract cannot fit in context', () => {
    const result = selectModelTaskBudget({ taskKind:'auto_inference', profileHardCap:30000,
      contextWindowTokens:32000, estimatedInputTokens:27000, schemaNeedTokens:8000 })
    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('output_budget_insufficient')
  })

  it('doubles the observed high-water mark after a trustworthy truncation', () => {
    const result = selectModelTaskBudget({ taskKind:'auto_inference', profileHardCap:30000,
      estimatedInputTokens:20000, schemaNeedTokens:1200, truncatedOutputHighWatermark:2000 })
    expect(result.selectedMaxOutputTokens).toBe(4000)
    expect(result.reason).toBe('output_truncation_growth')
  })

  it('learns p95 only from settled complete output while retaining truncation evidence', () => {
    expect(summarizeModelOutputHistory([
      { output_tokens:1200, request_status:'success', accounting_status:'settled', finish_reason:'completed' },
      { output_tokens:1600, request_status:'success', accounting_status:'settled', finish_reason:'stop' },
      { output_tokens:2000, request_status:'error', accounting_status:'settled', error_code:'output_truncated', finish_reason:'incomplete' },
      { output_tokens:9000, request_status:'success', accounting_status:'estimated', finish_reason:null },
    ])).toEqual({ historicalOutputP95:1600, truncatedOutputHighWatermark:2000,
      completedSamples:2, truncatedSamples:1 })
  })

  it('ignores repair and empty-retry rows when learning the primary budget high-water', () => {
    expect(summarizeModelOutputHistory([
      { request_phase:'request', output_tokens:1200, request_status:'success', accounting_status:'settled', finish_reason:'stop' },
      { request_phase:'repair', output_tokens:9000, request_status:'error', accounting_status:'settled', error_code:'output_truncated', finish_reason:'length' },
      { request_phase:'repair', output_tokens:8000, request_status:'success', accounting_status:'settled', finish_reason:'stop' },
      { request_phase:null, output_tokens:1600, request_status:'success', accounting_status:'settled', finish_reason:'stop' },
    ])).toEqual({ historicalOutputP95:1600, truncatedOutputHighWatermark:0,
      completedSamples:2, truncatedSamples:0 })
  })

  it('uses the smaller business deadline and keeps manual timeout as a tightening cap', () => {
    expect(modelTaskDeadlines('daily_review', {
      nowUtcMs:1000, manualAttemptMs:90_000, businessDeadlineUtcMs:200_000,
    })).toEqual({ attemptSafetyDeadlineUtcMs:91_000, taskDeadlineUtcMs:200_000 })
  })

  it('uses a conservative input estimate', () => {
    expect(estimateModelInputTokens('中'.repeat(3200))).toBe(1000)
  })

  it('uses the confirmed physical output even when task history and schema need are smaller', () => {
    const result = selectModelTaskBudget({ taskKind:'auto_inference', profileHardCap:8_000,
      estimatedInputTokens:10_000, schemaNeedTokens:1_200, historicalOutputP95:4_000,
      truncatedOutputHighWatermark:2_000, capabilities:{
        token_limits_status:'confirmed', token_limits_source:'manual_confirmed',
        context_window_tokens:1_048_576, max_input_tokens:1_048_576,
        max_output_tokens:393_216, context_limit_semantics:'shared_context',
      } })
    expect(result.selectedMaxOutputTokens).toBe(393_216)
    expect(result.legacyFallback).toBe(false)
    expect(result.tokenLimitsStatus).toBe('confirmed')
  })

  it('deducts estimated input from a confirmed shared context only', () => {
    const result = selectModelTaskBudget({ taskKind:'manual_analysis', profileHardCap:2_000,
      estimatedInputTokens:90, schemaNeedTokens:50, capabilities:{
        token_limits_status:'confirmed', context_window_tokens:100, max_input_tokens:100,
        max_output_tokens:80, context_limit_semantics:'shared_context',
      } })
    expect(result.selectedMaxOutputTokens).toBe(10)
    expect(result.contextRoomTokens).toBe(10)
    const separate = selectModelTaskBudget({ taskKind:'manual_analysis', profileHardCap:2_000,
      estimatedInputTokens:90, capabilities:{
        token_limits_status:'confirmed', context_window_tokens:100, max_input_tokens:100,
        max_output_tokens:80, context_limit_semantics:'separate',
      } })
    expect(separate.selectedMaxOutputTokens).toBe(80)
  })

  it('fails with stable input and output budget reasons under confirmed limits', () => {
    const input = selectModelTaskBudget({ taskKind:'manual_analysis', estimatedInputTokens:101,
      capabilities:{ token_limits_status:'confirmed', context_window_tokens:1000,
        max_input_tokens:100, max_output_tokens:80, context_limit_semantics:'shared_context' } })
    expect(input.reason).toBe('model_input_limit_exceeded')
    expect(input.sufficient).toBe(false)
    const output = selectModelTaskBudget({ taskKind:'manual_analysis', estimatedInputTokens:1000,
      capabilities:{ token_limits_status:'confirmed', context_window_tokens:1000,
        max_input_tokens:2000, max_output_tokens:80, context_limit_semantics:'shared_context' } })
    expect(output.reason).toBe('output_budget_insufficient')
    expect(output.sufficient).toBe(false)
  })

  it('marks the migration path and keeps profile max_tokens as the legacy fallback', () => {
    const result = selectModelTaskBudget({ taskKind:'manual_analysis', profileHardCap:7_777,
      estimatedInputTokens:100, schemaNeedTokens:1_200, capabilities:{
        token_limits_status:'default_unconfirmed', context_window_tokens:1_048_576,
        max_input_tokens:1_048_576, max_output_tokens:393_216,
      } })
    expect(result.selectedMaxOutputTokens).toBe(2_000)
    expect(result.legacyFallback).toBe(true)
    expect(result.tokenLimitsStatus).toBe('default_unconfirmed')
  })

  it('keeps manual trade review legacy cap shaping while confirmed limits ignore it', () => {
    const legacyProfileCap = Math.min(4_096, Math.max(1_200, 8_000))
    const legacy = selectModelTaskBudget({ taskKind:'manual_analysis', profileHardCap:legacyProfileCap,
      estimatedInputTokens:100, capabilities:{ token_limits_status:'default_unconfirmed' },
      legacyExactProfileCap:true })
    expect(legacy.selectedMaxOutputTokens).toBe(4_096)
    expect(legacy.legacyFallback).toBe(true)
    const confirmed = selectModelTaskBudget({ taskKind:'manual_analysis', profileHardCap:legacyProfileCap,
      estimatedInputTokens:100, capabilities:{ token_limits_status:'confirmed',
        context_window_tokens:1_048_576, max_input_tokens:1_048_576,
        max_output_tokens:393_216, context_limit_semantics:'shared_context' },
      legacyExactProfileCap:true })
    expect(confirmed.selectedMaxOutputTokens).toBe(393_216)
    expect(confirmed.legacyFallback).toBe(false)
  })
})
