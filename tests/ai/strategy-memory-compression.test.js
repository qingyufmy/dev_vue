import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(),
  requestJsonObject:vi.fn(), resolveAiTaskModel:vi.fn(),
  getModelProviderCapabilities:vi.fn(), createModelTaskTracker:vi.fn(),
  recoverAbandonedBusinessModelTasks:vi.fn(),
  selectModelTaskBudget:vi.fn(), estimateModelInputTokens:vi.fn(), modelTaskDeadlines:vi.fn(),
  applyStrategyMemoryCompressionJob:vi.fn(), claimStrategyMemoryCompressionJob:vi.fn(),
  failStrategyMemoryCompressionJob:vi.fn(), renewStrategyMemoryCompressionLease:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  queryAll:(...args) => mocks.queryAll(...args), queryOne:(...args) => mocks.queryOne(...args),
  queryRun:(...args) => mocks.queryRun(...args), beijingNow:() => '2026-08-12 15:30:00',
}))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject:(...args) => mocks.requestJsonObject(...args) }))
vi.mock('../../server/routes/ai/model-profiles.js', () => ({ resolveAiTaskModel:(...args) => mocks.resolveAiTaskModel(...args) }))
vi.mock('../../server/routes/ai/model-provider-capabilities.js', () => ({
  getModelProviderCapabilities:(...args) => mocks.getModelProviderCapabilities(...args),
}))
vi.mock('../../server/routes/ai/model-task-tracker.js', () => ({
  createModelTaskTracker:(...args) => mocks.createModelTaskTracker(...args),
}))
vi.mock('../../server/routes/ai/model-task-runtime.js', () => ({
  recoverAbandonedBusinessModelTasks:(...args) => mocks.recoverAbandonedBusinessModelTasks(...args),
}))
vi.mock('../../server/routes/ai/model-task-budget.js', () => ({
  selectModelTaskBudget:(...args) => mocks.selectModelTaskBudget(...args),
  estimateModelInputTokens:(...args) => mocks.estimateModelInputTokens(...args),
  modelTaskDeadlines:(...args) => mocks.modelTaskDeadlines(...args),
}))
vi.mock('../../server/routes/ai/strategy-memory-library.js', () => ({
  applyStrategyMemoryCompressionJob:(...args) => mocks.applyStrategyMemoryCompressionJob(...args),
  claimStrategyMemoryCompressionJob:(...args) => mocks.claimStrategyMemoryCompressionJob(...args),
  failStrategyMemoryCompressionJob:(...args) => mocks.failStrategyMemoryCompressionJob(...args),
  renewStrategyMemoryCompressionLease:(...args) => mocks.renewStrategyMemoryCompressionLease(...args),
  sanitizeStrategyMemoryText:value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ''),
  strategyMemoryCharCount:value => Array.from(String(value ?? '')).length,
}))

import {
  buildStrategyMemoryCompressionMessages,
  prepareStrategyMemoryCompressionModelCall,
  recoverAbandonedStrategyMemoryCompressionModelTasks,
  runStrategyMemoryCompressionOnce,
} from '../../server/routes/ai/strategy-memory-compression.js'

const strategy = { id:5, scope:'private', owner_user_id:7, title:'策略 A', version:4, system_prompt:'只做顺势交易' }
const library = { strategy_id:5, version_no:3, content_hash:'h'.repeat(64), content_text:'# 已确认经验\n- 等待确认', char_count:10 }
const job = { id:11, strategy_id:5, source_version_no:3, source_content_hash:'h'.repeat(64),
  pending_update_ids_json:'[]', target_chars:120, status:'leased', lease_token:'lease-11',
  attempt_count:1, max_attempts:3, last_error_code:null }

function configureModel({ request = null, tracker = null } = {}) {
  mocks.resolveAiTaskModel.mockResolvedValue({
    model:{ provider:'deepseek', model_name:'deepseek-chat', api_base_url:'https://api.deepseek.com',
      api_key_encrypted:'secret', thinking_enabled:false, reasoning_effort:'max' },
    credential_source:'user', model_profile_id:9,
  })
  mocks.getModelProviderCapabilities.mockResolvedValue({
    token_limits_status:'confirmed', token_limits_source:'manual_confirmed',
    context_window_tokens:10000, max_input_tokens:9000, max_output_tokens:2000,
    context_limit_semantics:'shared_context',
  })
  mocks.estimateModelInputTokens.mockReturnValue(300)
  mocks.selectModelTaskBudget.mockReturnValue({ sufficient:true, selectedMaxOutputTokens:2000,
    estimatedInputTokens:300, contextWindowTokens:10000, maxInputTokens:9000,
    providerMaxInputTokens:9000, providerOutputCap:2000, contextLimitSemantics:'shared_context',
    tokenLimitsStatus:'confirmed', tokenLimitsSource:'manual_confirmed' })
  mocks.modelTaskDeadlines.mockReturnValue({ attemptSafetyDeadlineUtcMs:Date.now() + 900_000,
    taskDeadlineUtcMs:Date.now() + 3_600_000 })
  mocks.claimStrategyMemoryCompressionJob.mockResolvedValue({ ...job })
  mocks.queryOne
    .mockResolvedValueOnce(strategy)
    .mockResolvedValueOnce(library)
  const defaultTracker = {
    signal:new AbortController().signal, status:'response_received',
    providerRequestState:{ submitted:false, responseReceived:false },
    assertOwned:vi.fn(), persistBudget:vi.fn(), resultReady:vi.fn(), applying:vi.fn(),
    succeeded:vi.fn(), failed:vi.fn().mockResolvedValue({ status:'failed_terminal' }), stop:vi.fn(),
    onProviderRequest:vi.fn(), onProviderUsage:vi.fn(), onProviderActivity:vi.fn(), onProviderQuiet:vi.fn(),
  }
  mocks.createModelTaskTracker.mockResolvedValue(tracker || defaultTracker)
  mocks.applyStrategyMemoryCompressionJob.mockResolvedValue({ revision_id:22, status:'succeeded' })
  mocks.failStrategyMemoryCompressionJob.mockResolvedValue({ status:'failed' })
  if (request) mocks.requestJsonObject.mockImplementation(request)
  return tracker || defaultTracker
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.renewStrategyMemoryCompressionLease.mockResolvedValue({ status:'leased' })
  mocks.queryRun.mockResolvedValue({ affectedRows:1 })
})

describe('strategy memory compression worker', () => {
  it('builds a complete frozen prompt with the strategy, full library and pending updates', () => {
    const messages = buildStrategyMemoryCompressionMessages({ strategy, strategyText:strategy.system_prompt,
      library:{ ...library, content_text:'x'.repeat(200) },
      pendingUpdates:[{ id:3, update_kind:'daily_review', content_text:'保留这个边界', source_refs_json:'["review:3"]' }],
      pendingIds:[3], targetChars:120 })
    expect(messages[0].content).toContain('不得创造新的交易规则')
    expect(messages[1].content).toContain('只做顺势交易')
    expect(messages[1].content).toContain('x'.repeat(200))
    expect(messages[1].content).toContain('保留这个边界')
    expect(messages[1].content).toContain('"target_chars":120')
  })

  it('passes confirmed physical provider limits into the budget selector', async () => {
    configureModel()
    await prepareStrategyMemoryCompressionModelCall({ model_profile_id:9 }, [{ role:'user', content:'完整提示' }])
    expect(mocks.getModelProviderCapabilities).toHaveBeenCalledWith(9)
    expect(mocks.selectModelTaskBudget).toHaveBeenCalledWith(expect.objectContaining({
      taskKind:'memory_compression', providerOutputCap:2000, maxInputTokens:9000,
      profile:null, estimatedInputTokens:300,
    }))
  })

  it('tracks and applies a successful compression result', async () => {
    const tracker = configureModel({ request:async options => {
      expect(options.maxTokens).toBe(2000)
      return { content_text:'# 压缩后的经验' }
    } })
    const result = await runStrategyMemoryCompressionOnce({ requestModel:mocks.requestJsonObject })
    expect(result.status).toBe('succeeded')
    expect(mocks.resolveAiTaskModel).toHaveBeenCalledWith({ userId:7, strategyId:5, usage:'memory_compression' })
    expect(tracker.persistBudget).toHaveBeenCalled()
    expect(mocks.applyStrategyMemoryCompressionJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId:11, leaseToken:'lease-11', content_text:'# 压缩后的经验',
    }))
    expect(tracker.succeeded).toHaveBeenCalled()
  })

  it('marks provider status unknown as non-retryable', async () => {
    const tracker = configureModel({ request:async options => {
      tracker.providerRequestState.submitted = true
      await options.onProviderRequest({ providerRequestId:'req-1' })
      throw new Error('socket closed after submit')
    } })
    tracker.status = 'status_unknown'
    tracker.failed.mockResolvedValue({ status:'status_unknown' })
    const result = await runStrategyMemoryCompressionOnce({ requestModel:mocks.requestJsonObject })
    expect(result.status).toBe('status_unknown')
    expect(mocks.failStrategyMemoryCompressionJob).toHaveBeenCalledWith(expect.objectContaining({
      retryable:false, errorCode:'provider_status_unknown',
    }))
  })

  it('requeues a deterministic validation/provider failure while attempts remain', async () => {
    const tracker = configureModel({ request:async () => {
      throw Object.assign(new Error('invalid response schema'), { code:'strategy_memory_compression_output_invalid' })
    } })
    tracker.failed.mockResolvedValue({ status:'retry_wait' })
    const result = await runStrategyMemoryCompressionOnce({ requestModel:mocks.requestJsonObject })
    expect(result.status).toBe('failed')
    expect(mocks.failStrategyMemoryCompressionJob).toHaveBeenCalledWith(expect.objectContaining({
      retryable:true, errorCode:'strategy_memory_compression_output_invalid',
    }))
  })

  it('does not start the retired legacy memory worker during server startup', () => {
    const source = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')
    expect(source).toContain('startStrategyMemoryCompressionWorker()')
    expect(source).not.toContain('startMemoryCompressionWorker()')
  })

  it('delegates recovery to the generic business-task reconciler', async () => {
    mocks.recoverAbandonedBusinessModelTasks.mockResolvedValue({ scanned:1, statusUnknown:1 })
    await expect(recoverAbandonedStrategyMemoryCompressionModelTasks({ nowUtcMs:100, limit:2 }))
      .resolves.toMatchObject({ scanned:1, statusUnknown:1 })
    expect(mocks.recoverAbandonedBusinessModelTasks).toHaveBeenCalledWith(expect.objectContaining({
      taskKinds:['memory_compression'], nowUtcMs:100, limit:2,
    }))
  })
})
