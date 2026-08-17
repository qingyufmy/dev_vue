import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('unified strategy memory runtime wiring', () => {
  it('links automatic inference attribution to the durable tracker task', () => {
    const scheduler = read('server/routes/ai/scheduler.js')
    expect(scheduler).toContain('modelTaskId:modelTaskTracker?.taskId || null')
    const trackerCreated = scheduler.indexOf('modelTaskTracker = await createTracker')
    const injectionCreated = scheduler.indexOf("injectionKind:'auto_inference', modelTaskId:modelTaskTracker.taskId")
    expect(trackerCreated).toBeGreaterThan(0)
    expect(injectionCreated).toBeGreaterThan(trackerCreated)
    expect(scheduler).not.toContain('modelTaskId:modelTask?.task_id || null')
  })

  it('freezes one current library for every model in a live comparison batch', () => {
    const strategy = read('server/routes/ai/strategy.js')
    const load = strategy.indexOf('const resolvedMemory = await getStrategyMemoryLibraryForRuntime')
    const batch = strategy.indexOf('const inferenceTaskPromises = validModels.map')
    expect(load).toBeGreaterThan(0)
    expect(load).toBeLessThan(batch)
    expect(strategy).toContain('_strategyMemoryLibraryContext:compareMemory.content_text')
    expect(strategy).toContain('await ensureCompareStrategyMemoryInjectionLog({ strategyId:Number(strategy.id)')
    expect(strategy).toContain("usageKind:'model_compare_live'")
  })

  it('uses one frozen library in both manual-trade review model stages', () => {
    const review = read('server/routes/ai/manual-trade-review.js')
    expect(review).toContain('const memory = memorySnapshot || (await getStrategyMemoryLibraryForRuntime')
    expect(review).toContain('const memorySnapshot = runtimeContext.memory')
    expect(review).toContain('content:memory?.content_text')
    expect(review).toContain('counterfactualPrompt(reviewCase, sources, memorySnapshot)')
    expect(review).toContain('outcomeReviewPrompt(reviewCase, sources, counterfactual, memorySnapshot)')
    expect(review).toContain('injectionKind:`manual_trade_review_${stage}`')
  })

  it('keeps historical comparison replay on its original frozen user prompt', () => {
    const llm = read('server/routes/ai/llm.js')
    expect(llm).toContain("typeof config._comparison_replay_user_prompt !== 'string'")
    expect(llm).toContain("typeof config._comparison_replay_user_prompt === 'string'")
  })

  it('starts and stops the durable memory consistency worker', () => {
    const server = read('server/index.js')
    const routes = read('server/routes/ai/index.js')
    expect(server).toContain('startStrategyMemoryConsistencyWorker()')
    expect(server).toContain('stopStrategyMemoryConsistencyWorker()')
    expect(routes).toContain('startStrategyMemoryConsistencyWorker, stopStrategyMemoryConsistencyWorker')
    expect(routes).toContain("router.post('/ai/strategy-memories/:strategyId/consistency-checks'")
    expect(routes).toContain("router.get('/ai/strategy-memories/:strategyId/preview'")
  })
})
