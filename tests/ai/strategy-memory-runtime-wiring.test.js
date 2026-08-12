import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('unified strategy memory runtime wiring', () => {
  it('links automatic inference attribution to the durable tracker task', () => {
    const scheduler = read('server/routes/ai/scheduler.js')
    expect(scheduler).toContain('modelTaskId:modelTaskTracker?.taskId || null')
    expect(scheduler).not.toContain('modelTaskId:modelTask?.task_id || null')
  })

  it('freezes one current library for every model in a live comparison batch', () => {
    const strategy = read('server/routes/ai/strategy.js')
    const load = strategy.indexOf('const resolvedMemory = await getStrategyMemoryLibraryForRuntime')
    const batch = strategy.indexOf('const inferenceTaskPromises = validModels.map')
    expect(load).toBeGreaterThan(0)
    expect(load).toBeLessThan(batch)
    expect(strategy).toContain('_strategyMemoryLibraryContext:compareMemory.content_text')
    expect(strategy).toContain("injectionKind:'model_compare_live'")
  })

  it('uses one frozen library in both manual-trade review model stages', () => {
    const review = read('server/routes/ai/manual-trade-review.js')
    expect(review).toContain('const memorySnapshot = (await getStrategyMemoryLibraryForRuntime')
    expect(review).toContain('counterfactualPrompt(reviewCase, sources, memorySnapshot)')
    expect(review).toContain('outcomeReviewPrompt(reviewCase, sources, counterfactual, memorySnapshot)')
    expect(review).toContain("injectionKind:'manual_trade_review'")
  })

  it('keeps historical comparison replay on its original frozen user prompt', () => {
    const llm = read('server/routes/ai/llm.js')
    expect(llm).toContain("typeof config._comparison_replay_user_prompt !== 'string'")
    expect(llm).toContain("typeof config._comparison_replay_user_prompt === 'string'")
  })
})
