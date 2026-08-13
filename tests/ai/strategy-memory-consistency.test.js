import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'

const mocks = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
  requestJsonObject:vi.fn(), resolveAiTaskModel:vi.fn(), getModelProviderCapabilities:vi.fn(),
  createModelTaskTracker:vi.fn(), recoverAbandonedBusinessModelTasks:vi.fn(),
  estimateModelInputTokens:vi.fn(), selectModelTaskBudget:vi.fn(), modelTaskDeadlines:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  queryAll:(...args) => mocks.queryAll(...args), queryOne:(...args) => mocks.queryOne(...args),
  queryRun:(...args) => mocks.queryRun(...args), withTransaction:(...args) => mocks.withTransaction(...args),
  beijingNow:() => '2026-08-13 10:00:00',
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
  estimateModelInputTokens:(...args) => mocks.estimateModelInputTokens(...args),
  selectModelTaskBudget:(...args) => mocks.selectModelTaskBudget(...args),
  modelTaskDeadlines:(...args) => mocks.modelTaskDeadlines(...args),
}))

import {
  STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION,
  buildStrategyMemoryConsistencyMessages,
  getLatestStrategyMemoryConsistencyJob,
  prepareStrategyMemoryConsistencyModelCall,
  queueStrategyMemoryConsistencyCheck,
  recoverAbandonedStrategyMemoryConsistencyModelTasks,
  runStrategyMemoryConsistencyOnce,
  validateStrategyMemoryConsistencyOutput,
} from '../../server/routes/ai/strategy-memory-consistency.js'

const strategyText = '# 入场规则\n\n只在 H1 趋势向上时做多。'
const memoryText = '# 复盘经验\n\n当 H1 趋势向上时，等待回踩后做多。'
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const memoryHash = hash(memoryText)
const strategyHash = hash(strategyText)

const job = {
  id:11, strategy_id:5, owner_user_id:7, strategy_version:3, library_version_no:4,
  strategy_content_hash:strategyHash, library_content_hash:memoryHash,
  strategy_text_snapshot:strategyText, memory_content_snapshot:memoryText,
  detector_contract_version:STRATEGY_MEMORY_CONSISTENCY_DETECTOR_CONTRACT_VERSION,
  input_set_hash:'a'.repeat(64), status:'leased', lease_token:'lease-11', lease_expires_at:'2026-08-13 10:15:00',
  attempt_count:1, max_attempts:3, trigger_type:'manual_check',
}

function configureDbForWorker() {
  mocks.withTransaction.mockImplementation(async callback => callback(async (sql) => {
    if (sql.startsWith('SELECT * FROM strategy_memory_consistency_jobs')) return [[{ ...job, status:'queued', lease_token:null, lease_expires_at:null }], []]
    return [{ affectedRows:1, insertId:11 }, []]
  }))
  mocks.queryOne.mockImplementation(async sql => {
    if (sql.includes('strategy_memory_consistency_jobs')) return { ...job, status:'succeeded_noop', result_hash:'b'.repeat(64) }
    if (sql.includes('auto_prompt_types')) return { version:3, system_prompt:strategyText, description:'' }
    if (sql.includes('strategy_memory_libraries')) return { version_no:4, content_hash:memoryHash }
    return null
  })
  mocks.queryRun.mockResolvedValue({ affectedRows:1, changes:1 })
  mocks.resolveAiTaskModel.mockResolvedValue({
    model:{ provider:'deepseek', model_name:'deepseek-chat', api_base_url:'https://api.deepseek.com',
      api_key_encrypted:'secret', thinking_enabled:false, reasoning_effort:null },
    credential_source:'user', model_profile_id:9,
  })
  mocks.getModelProviderCapabilities.mockResolvedValue({
    token_limits_status:'confirmed', token_limits_source:'manual_confirmed',
    context_window_tokens:10000, max_input_tokens:9000, max_output_tokens:2000,
    context_limit_semantics:'shared_context', supports_stream:false,
  })
  mocks.estimateModelInputTokens.mockReturnValue(500)
  mocks.selectModelTaskBudget.mockReturnValue({ sufficient:true, selectedMaxOutputTokens:2000,
    estimatedInputTokens:500, maxInputTokens:9000, providerMaxInputTokens:9000,
    contextWindowTokens:10000, providerOutputCap:2000, contextLimitSemantics:'shared_context',
    tokenLimitsStatus:'confirmed', tokenLimitsSource:'manual_confirmed' })
  mocks.modelTaskDeadlines.mockReturnValue({ attemptSafetyDeadlineUtcMs:Date.now() + 900_000,
    taskDeadlineUtcMs:Date.now() + 3_600_000 })
  const tracker = {
    signal:new AbortController().signal, status:'response_received',
    providerRequestState:{ submitted:false, responseReceived:false },
    persistBudget:vi.fn().mockResolvedValue(true), resultReady:vi.fn().mockResolvedValue(true),
    applying:vi.fn().mockResolvedValue(true), succeeded:vi.fn().mockResolvedValue(true),
    failed:vi.fn().mockResolvedValue({ status:'failed_terminal' }),
    completedStale:vi.fn().mockResolvedValue(true), stop:vi.fn().mockResolvedValue(true),
    assertOwned:vi.fn(), onProviderRequest:vi.fn(), onProviderUsage:vi.fn(),
    onProviderActivity:vi.fn(), onProviderQuiet:vi.fn(), taskId:'model-task-11',
  }
  mocks.createModelTaskTracker.mockResolvedValue(tracker)
  mocks.requestJsonObject.mockResolvedValue({ candidates:[] })
  return tracker
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recoverAbandonedBusinessModelTasks.mockResolvedValue({ scanned:0, succeeded:0 })
})

describe('strategy memory consistency contract', () => {
  it('freezes complete strategy and memory text without an application token cap', () => {
    const messages = buildStrategyMemoryConsistencyMessages({
      strategy:{ id:5, version:3 }, strategyText, library:{ version_no:4, content_hash:memoryHash }, memoryText,
    })
    const payload = JSON.parse(messages[1].content)
    expect(payload.strategy.text).toBe(strategyText)
    expect(payload.memory_library.content_text).toBe(memoryText)
    expect(messages[0].content).toContain('不能改写、截断')
    expect(messages[1].content).not.toContain('max_tokens')
  })

  it('accepts exact source excerpts and ignores model conflict keys, positions and markup', () => {
    const result = validateStrategyMemoryConsistencyOutput({
      strategyText, memoryText,
      output:{ candidates:[{
        conflict_key:'model-forged-key', position:{ start:0 }, html:'<mark>red</mark>',
        category:'risk_execution', strategy_excerpt:'只在 H1 趋势向上时做多。',
        memory_excerpt:'当 H1 趋势向上时，等待回踩后做多。',
        summary:'<b>策略与经验的方向一致但入场条件不同</b>', suggested_change:'人工核对策略边界。',
      }] },
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).not.toHaveProperty('conflict_key')
    expect(result.candidates[0]).not.toHaveProperty('position')
    expect(result.candidates[0].summary).not.toContain('<b>')
    expect(result.candidates[0].memory_block_id).toEqual(expect.any(String))
  })

  it('rejects absent excerpts instead of accepting a model paraphrase', () => {
    expect(() => validateStrategyMemoryConsistencyOutput({ strategyText, memoryText,
      output:{ candidates:[{ category:'general', strategy_excerpt:'策略要求做空',
        memory_excerpt:'经验要求做空', summary:'冲突', suggested_change:'人工检查' }] } }))
      .toThrow('strategy_memory_consistency_strategy_excerpt_not_found')
  })

  it('fails closed for ambiguous excerpts and unsupported categories', () => {
    const duplicateStrategy = `${strategyText}\n\n只在 H1 趋势向上时做多。`
    expect(() => validateStrategyMemoryConsistencyOutput({ strategyText:duplicateStrategy, memoryText,
      output:{ candidates:[{ category:'general', strategy_excerpt:'只在 H1 趋势向上时做多。',
        memory_excerpt:'当 H1 趋势向上时，等待回踩后做多。', summary:'冲突', suggested_change:'人工检查' }] } }))
      .toThrow('strategy_memory_consistency_strategy_excerpt_not_found')
    expect(() => validateStrategyMemoryConsistencyOutput({ strategyText, memoryText,
      output:{ candidates:[{ category:'invented_category', strategy_excerpt:'只在 H1 趋势向上时做多。',
        memory_excerpt:'当 H1 趋势向上时，等待回踩后做多。', summary:'冲突', suggested_change:'人工检查' }] } }))
      .toThrow('strategy_memory_consistency_category_invalid')
  })

  it('queues one frozen input and reuses the durable row', async () => {
    const strategy = { id:5, version:3, system_prompt:strategyText, description:'', scope:'private', owner_user_id:7 }
    const library = { version_no:4, content_hash:memoryHash, content_text:memoryText }
    mocks.queryOne.mockImplementation(async sql => sql.includes('auto_prompt_types') ? strategy : library)
    let existing = null
    mocks.withTransaction.mockImplementation(async callback => callback(async (sql, params) => {
      if (sql.includes('SELECT * FROM strategy_memory_consistency_jobs')) return [[existing], []]
      if (sql.startsWith('INSERT IGNORE INTO')) { existing = { ...job, status:'queued', input_set_hash:params[9] }; return [{ insertId:11, affectedRows:1 }, []] }
      if (sql.startsWith('SELECT * FROM strategy_memory_consistency_jobs WHERE id')) return [[existing], []]
      return [{ affectedRows:1 }, []]
    }))
    const first = await queueStrategyMemoryConsistencyCheck({ strategyId:5, strategyText, memoryContent:memoryText,
      triggerType:'manual_check' })
    expect(first.created).toBe(true)
    expect(existing.strategy_text_snapshot).toBe(strategyText)
    const insertCall = mocks.withTransaction.mock.calls[0]
    expect(insertCall).toBeTruthy()
    const second = await queueStrategyMemoryConsistencyCheck({ strategyId:5, strategyText, memoryContent:memoryText,
      triggerType:'manual_check' })
    expect(second.replayed).toBe(true)
  })

  it('uses confirmed physical limits and full prompt estimate', async () => {
    configureDbForWorker()
    await prepareStrategyMemoryConsistencyModelCall({ model_profile_id:9 }, [{ role:'user', content:'完整输入' }])
    expect(mocks.selectModelTaskBudget).toHaveBeenCalledWith(expect.objectContaining({
      taskKind:'strategy_memory_consistency', profile:null, maxInputTokens:9000, providerOutputCap:2000,
    }))
  })
})

describe('strategy memory consistency worker', () => {
  it('returns succeeded_noop without writing evidence_count when no candidate is found', async () => {
    const tracker = configureDbForWorker()
    const result = await runStrategyMemoryConsistencyOnce({ applyValidatedFindings:vi.fn() })
    expect(result.status).toBe('succeeded_noop')
    expect(tracker.succeeded).toHaveBeenCalledWith(expect.objectContaining({ resultRef:'strategy_memory_consistency:11' }))
    expect(mocks.queryRun.mock.calls.map(call => call[0]).join('\n')).not.toContain('evidence_count')
  })

  it('persists only validated candidates and never trusts conflict_key', async () => {
    const tracker = configureDbForWorker()
    mocks.requestJsonObject.mockResolvedValue({ candidates:[{
      conflict_key:'forged', category:'general', strategy_excerpt:'只在 H1 趋势向上时做多。',
      memory_excerpt:'当 H1 趋势向上时，等待回踩后做多。', summary:'需人工核对', suggested_change:'检查边界。',
    }] })
    const result = await runStrategyMemoryConsistencyOnce({ applyValidatedFindings:vi.fn() })
    expect(result.status).toBe('succeeded')
    const resultJson = String(mocks.queryRun.mock.calls.at(-1)?.[1]?.[5] || '')
    expect(resultJson).not.toContain('forged')
    expect(tracker.succeeded).toHaveBeenCalled()
  })

  it('keeps an invalid provider response failed and leaves memory/compression untouched', async () => {
    const tracker = configureDbForWorker()
    mocks.requestJsonObject.mockRejectedValue(Object.assign(new Error('missing excerpt'), {
      code:'strategy_memory_consistency_memory_excerpt_not_found',
    }))
    tracker.failed.mockResolvedValue({ status:'failed_terminal' })
    const result = await runStrategyMemoryConsistencyOnce()
    expect(result.status).toBe('failed')
    expect(mocks.queryRun.mock.calls.map(call => call[0]).join('\n')).not.toContain('strategy_memory_libraries')
    expect(tracker.failed).toHaveBeenCalled()
  })

  it('does not retry a submitted provider request with unknown status', async () => {
    const tracker = configureDbForWorker()
    tracker.status = 'status_unknown'
    tracker.providerRequestState.submitted = true
    tracker.providerRequestState.responseReceived = false
    tracker.failed.mockResolvedValue({ status:'status_unknown' })
    mocks.requestJsonObject.mockRejectedValue(new Error('socket closed after submit'))
    const result = await runStrategyMemoryConsistencyOnce()
    expect(result.status).toBe('status_unknown')
    const failureSql = mocks.queryRun.mock.calls.map(call => call[0]).join('\n')
    expect(failureSql).toContain("status = ?")
  })

  it('delegates recovery and treats a succeeded_noop business result as terminal success', async () => {
    configureDbForWorker()
    mocks.recoverAbandonedBusinessModelTasks.mockResolvedValue({ scanned:1, succeeded:1 })
    const result = await recoverAbandonedStrategyMemoryConsistencyModelTasks({ nowUtcMs:100, limit:2 })
    expect(result).toMatchObject({ scanned:1, succeeded:1 })
    const opts = mocks.recoverAbandonedBusinessModelTasks.mock.calls[0][0]
    expect(opts.taskKinds).toEqual(['strategy_memory_consistency'])
    const inspection = await opts.inspectBusiness({ task_id:'model-task-11' })
    expect(inspection.succeeded).toBe(true)
  })

  it('reads the latest job without exposing internal task identity, lease or raw result', async () => {
    mocks.queryOne.mockResolvedValue({ ...job, status:'succeeded_noop', result_json:'{"contract_version":1,"candidates":[]}', lease_token:'secret', model_task_id:77 })
    const latest = await getLatestStrategyMemoryConsistencyJob(5, { strategyVersion:3, libraryVersionNo:4 })
    expect(latest.status).toBe('succeeded_noop')
    expect(latest.result_json).toBeUndefined()
    expect(latest.lease_token).toBeUndefined()
    expect(latest.model_task_id).toBeUndefined()
    expect(latest.strategy_text_snapshot).toBeUndefined()
    expect(latest.memory_content_snapshot).toBeUndefined()
    expect(latest.result_summary).toEqual({ contract_version:1, conflict_count:0, matched_count:0, stale_count:0 })
  })
})
