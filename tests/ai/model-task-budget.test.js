import { describe, expect, it } from 'vitest'
import { estimateModelInputTokens, modelTaskDeadlines, selectModelTaskBudget,
  summarizeModelOutputHistory } from '../../server/routes/ai/model-task-budget.js'

describe('model task adaptive budget', () => {
  it('uses only confirmed physical limits, ignoring profile, task and history caps', () => {
    const result = selectModelTaskBudget({ taskKind:'auto_inference', profile:{ max_tokens:8_000 },
      estimatedInputTokens:10_000, schemaNeedTokens:1_200, historicalOutputP95:4_000,
      truncatedOutputHighWatermark:2_000, capabilities:{
        token_limits_status:'confirmed', token_limits_source:'manual_confirmed',
        context_window_tokens:1_048_576, max_input_tokens:1_048_576,
        max_output_tokens:393_216, context_limit_semantics:'shared_context',
      } })
    expect(result.selectedMaxOutputTokens).toBe(393_216)
    expect(result).not.toHaveProperty('profileHardCap')
    expect(result).not.toHaveProperty('taskCap')
    expect(result).not.toHaveProperty('legacyFallback')
    expect(result.tokenLimitsStatus).toBe('confirmed')
  })

  it('uses separate physical output without deducting input', () => {
    const result = selectModelTaskBudget({ taskKind:'monthly_review_merge', profile:{ max_tokens:500 },
      estimatedInputTokens:70_000, capabilities:{
        token_limits_status:'confirmed', context_window_tokens:160_000, max_input_tokens:80_000,
        max_output_tokens:64_000, context_limit_semantics:'separate',
      } })
    expect(result.selectedMaxOutputTokens).toBe(64_000)
    expect(result.sufficient).toBe(true)
    expect(result.contextRoomTokens).toBeNull()
  })

  it('rejects missing or stale physical capability confirmation', () => {
    const unconfirmed = selectModelTaskBudget({ taskKind:'manual_analysis', estimatedInputTokens:100,
      capabilities:{ token_limits_status:'default_unconfirmed', max_output_tokens:393_216 } })
    expect(unconfirmed).toMatchObject({ selectedMaxOutputTokens:0, sufficient:false, reason:'model_token_limits_unconfirmed' })
    const stale = selectModelTaskBudget({ taskKind:'manual_analysis', estimatedInputTokens:100,
      capabilities:{ token_limits_status:'stale', max_output_tokens:393_216 } })
    expect(stale).toMatchObject({ selectedMaxOutputTokens:0, sufficient:false, reason:'model_token_limits_stale' })
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

  it('deducts estimated input from a confirmed shared context only', () => {
    const result = selectModelTaskBudget({ taskKind:'manual_analysis',
      estimatedInputTokens:90, schemaNeedTokens:50, capabilities:{
        token_limits_status:'confirmed', context_window_tokens:100, max_input_tokens:100,
        max_output_tokens:80, context_limit_semantics:'shared_context',
      } })
    expect(result.selectedMaxOutputTokens).toBe(10)
    expect(result.contextRoomTokens).toBe(10)
    const separate = selectModelTaskBudget({ taskKind:'manual_analysis',
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

})
