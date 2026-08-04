import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  queryAll, queryOne, queryRun, withTransaction, handleAnalyze, getStrategyById, getAnalyzeApiKey,
  createModelTask, claimModelTaskById, beginModelTaskAttempt, finishModelTaskAttempt,
  renewModelTaskLease, transitionModelTask, cancelModelTaskById, markModelTaskStatusUnknownById,
  markModelTaskSucceededFromResult, markModelTaskCompletedStaleById,
} = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(), handleAnalyze:vi.fn(),
  getStrategyById:vi.fn(), getAnalyzeApiKey:vi.fn(), createModelTask:vi.fn(),
  claimModelTaskById:vi.fn(), beginModelTaskAttempt:vi.fn(), finishModelTaskAttempt:vi.fn(),
  renewModelTaskLease:vi.fn(), transitionModelTask:vi.fn(), cancelModelTaskById:vi.fn(), markModelTaskStatusUnknownById:vi.fn(),
  markModelTaskSucceededFromResult:vi.fn(), markModelTaskCompletedStaleById:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({ queryAll, queryOne, queryRun, withTransaction }))
vi.mock('../../server/routes/ai/strategy.js', () => ({ handleAnalyze }))
vi.mock('../../server/routes/ai/strategy-ownership.js', () => ({ getStrategyById }))
vi.mock('../../server/routes/ai/config.js', () => ({ getAnalyzeApiKey }))
vi.mock('../../server/routes/ai/model-task-runtime.js', () => ({
  createModelTask, claimModelTaskById, beginModelTaskAttempt, finishModelTaskAttempt,
  renewModelTaskLease, transitionModelTask, cancelModelTaskById, markModelTaskStatusUnknownById,
  markModelTaskSucceededFromResult, markModelTaskCompletedStaleById,
}))

import { createManualAnalysisJob, recoverManualAnalysisJobs, __manualAnalysisJobsTest } from '../../server/routes/ai/manual-analysis-jobs.js'

function mockManualJobLookups(job, task = null) {
  queryOne.mockImplementation(async sql => {
    if (sql.includes('FROM ai_manual_analysis_jobs')) return job
    if (sql.includes('FROM ai_signals')) return null
    if (sql.includes('FROM ai_model_tasks')) return task
    return null
  })
}

describe('manual analysis durable jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markModelTaskSucceededFromResult.mockResolvedValue(true)
    markModelTaskCompletedStaleById.mockResolvedValue(true)
    getStrategyById.mockResolvedValue({ id:7, version:3, system_prompt:'prompt' })
    getAnalyzeApiKey.mockResolvedValue({ api_provider:'deepseek', model_name:'deepseek-chat', _model_profile_id:4, _credential_source:'user' })
  })

  it('rejects auto execution before creating a durable task', async () => {
    await expect(createManualAnalysisJob(9, { symbol:'XAUUSD', strategy_id:7, auto_execute:true })).rejects.toMatchObject({
      code:'manual_analysis_auto_execute_forbidden',
    })
    expect(createModelTask).not.toHaveBeenCalled()
  })

  it('freezes strategy version, prompt and request input in the task envelope', async () => {
    createModelTask.mockResolvedValue({ created:true, task:{ task_id:'task-1' } })
    queryOne
      .mockResolvedValueOnce(null) // load job by task
      .mockResolvedValueOnce({ job_id:'job-1', user_id:9, strategy_id:7, strategy_version:3,
        strategy_prompt_hash:__manualAnalysisJobsTest.sha256('prompt'), model_task_id:'task-1', status:'queued', stage:'queued',
        params_json:'{"symbol":"XAUUSD","strategy_id":7,"auto_execute":false}', created_at_utc_msc:1,
        updated_at_utc_msc:1 })
    // Stop the spawned worker at its first lookup; this test targets the
    // durable envelope, not provider execution.
    claimModelTaskById.mockResolvedValue(null)
    const job = await createManualAnalysisJob(9, { symbol:'XAUUSD', strategy_id:7, auto_execute:false }, { waitForCompletion:false })
    expect(createModelTask).toHaveBeenCalledWith(expect.objectContaining({
      taskKind:'manual_analysis', queueClass:'interactive', strategyId:7,
      promptHash:__manualAnalysisJobsTest.sha256('prompt'),
      frozenContext:expect.objectContaining({ strategy_version:3, prompt_hash:__manualAnalysisJobsTest.sha256('prompt') }),
    }))
    expect(job.id).toBe('job-1')
  })

  it('reuses a non-terminal task for the same user and request hash', async () => {
    const existingTask = { task_id:'task-live', status:'provider_running' }
    const existingJob = { job_id:'job-live', user_id:9, model_task_id:'task-live', strategy_id:7,
      strategy_version:3, status:'running', stage:'provider_running', params_json:'{}', created_at_utc_msc:1 }
    createModelTask.mockResolvedValue({ created:false, task:existingTask })
    queryOne.mockResolvedValue(existingJob)
    const job = await createManualAnalysisJob(9, { symbol:'XAUUSD', strategy_id:7 }, { waitForCompletion:false })
    expect(job.id).toBe('job-live')
    expect(createModelTask).toHaveBeenCalledTimes(1)
  })

  it('reuses a non-terminal task for an explicit client key', async () => {
    const existingTask = { task_id:'task-live-explicit', status:'queued',
      frozen_context_json:JSON.stringify({ strategy_version:3 }) }
    const existingJob = { job_id:'job-live-explicit', user_id:9, model_task_id:'task-live-explicit', strategy_id:7,
      strategy_version:3, status:'queued', stage:'queued', deadline_at_utc_msc:Date.now() + 60_000,
      params_json:'{"symbol":"XAUUSD","strategy_id":7,"auto_execute":false}', created_at_utc_msc:1 }
    createModelTask.mockResolvedValue({ created:false, task:existingTask })
    mockManualJobLookups(existingJob, existingTask)
    const job = await createManualAnalysisJob(9, {
      symbol:'XAUUSD', strategy_id:7, request_id:'explicit-live-key',
    }, { waitForCompletion:false })
    expect(job.id).toBe('job-live-explicit')
    expect(createModelTask).toHaveBeenCalledTimes(1)
    expect(createModelTask.mock.calls[0][0].idempotencyKey).toBe('manual:9:explicit-live-key')
  })

  it('replays a terminal task for an explicit client key without creating a retry', async () => {
    const existingTask = { task_id:'task-terminal', status:'succeeded' }
    const existingJob = { job_id:'job-terminal', user_id:9, model_task_id:'task-terminal', strategy_id:7,
      strategy_version:3, status:'succeeded', stage:'completed', result_json:'{"status":"success"}',
      params_json:'{"symbol":"XAUUSD","strategy_id":7,"auto_execute":false}', created_at_utc_msc:1 }
    createModelTask.mockResolvedValue({ created:false, task:existingTask })
    mockManualJobLookups(existingJob, existingTask)
    const job = await createManualAnalysisJob(9, {
      symbol:'XAUUSD', strategy_id:7, request_id:'terminal-replay-key',
    }, { waitForCompletion:false })
    expect(job).toMatchObject({ id:'job-terminal', status:'succeeded', result:{ status:'success' } })
    expect(createModelTask).toHaveBeenCalledTimes(1)
    expect(createModelTask.mock.calls[0][0].idempotencyKey).toBe('manual:9:terminal-replay-key')
  })

  it('retries a terminal task for a deliberate no-key repeat', async () => {
    const oldTask = { task_id:'task-old-terminal', status:'succeeded' }
    const newTask = { task_id:'task-new-repeat', status:'queued' }
    const existingJob = { job_id:'job-new-repeat', user_id:9, model_task_id:'task-new-repeat', strategy_id:7,
      strategy_version:3, status:'queued', stage:'queued', deadline_at_utc_msc:Date.now() + 60_000,
      params_json:'{"symbol":"XAUUSD","strategy_id":7,"auto_execute":false}', created_at_utc_msc:1 }
    createModelTask
      .mockResolvedValueOnce({ created:false, task:oldTask })
      .mockResolvedValueOnce({ created:true, task:newTask })
    mockManualJobLookups(existingJob, newTask)
    const job = await createManualAnalysisJob(9, {
      symbol:'XAUUSD', strategy_id:7,
    }, { waitForCompletion:false })
    expect(job.id).toBe('job-new-repeat')
    expect(createModelTask).toHaveBeenCalledTimes(2)
    expect(createModelTask.mock.calls[1][0].idempotencyKey).toMatch(/^manual:9:source:.+:retry:/)
  })

  it('rejects reusing an explicit idempotency key with a different frozen request', async () => {
    createModelTask.mockResolvedValue({ created:false, task:{
      task_id:'task-conflict', status:'provider_running', input_hash:'different-input',
    } })
    await expect(createManualAnalysisJob(9, {
      symbol:'XAUUSD', strategy_id:7, request_id:'same-client-key',
    }, { waitForCompletion:false })).rejects.toThrow('manual_analysis_idempotency_conflict')
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('rejects an explicit key when the frozen provider protocol changed', async () => {
    getAnalyzeApiKey.mockResolvedValue({ api_provider:'deepseek', model_name:'deepseek-chat',
      protocol:'responses', _model_profile_id:4, _credential_source:'user' })
    createModelTask.mockResolvedValue({ created:false, task:{
      task_id:'task-protocol-conflict', status:'provider_running', frozen_protocol:'chat_completions',
    } })
    await expect(createManualAnalysisJob(9, {
      symbol:'XAUUSD', strategy_id:7, request_id:'same-protocol-key',
    }, { waitForCompletion:false })).rejects.toThrow('manual_analysis_idempotency_conflict')
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('normalizes public terminal errors without leaking frozen internals', () => {
    const job = __manualAnalysisJobsTest.publicJob({
      job_id:'job-1', user_id:9, status:'failed', stage:'failed', error_code:'provider_error',
      error_message:'provider unavailable', params_json:'{"symbol":"XAUUSD"}',
      strategy_id:7, strategy_version:3, model_task_id:'task-1', created_at_utc_msc:1,
    })
    expect(job).toMatchObject({ id:'job-1', status:'failed', error:{ code:'provider_error', message:'provider unavailable' } })
    expect(job).not.toHaveProperty('systemPrompt')
  })

  it('classifies only a submitted request without a verified response as status unknown', () => {
    expect(__manualAnalysisJobsTest.providerOutcomeUnknown({ submitted:true, responseReceived:false })).toBe(true)
    expect(__manualAnalysisJobsTest.providerOutcomeUnknown({ submitted:true, responseReceived:true })).toBe(false)
    expect(__manualAnalysisJobsTest.providerOutcomeUnknown({ submitted:false, responseReceived:false })).toBe(false)
  })

  it('keeps status unknown before its task deadline and finalizes it stale after the deadline', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(100_000)
      queryAll.mockResolvedValueOnce([{ job_id:'job-unknown', model_task_id:'task-unknown',
        status:'status_unknown', task_status:'status_unknown', task_deadline_at_utc_msc:120_000 }])
      await recoverManualAnalysisJobs()
      expect(markModelTaskCompletedStaleById).not.toHaveBeenCalled()

      vi.setSystemTime(130_000)
      queryAll.mockResolvedValueOnce([{ job_id:'job-unknown', model_task_id:'task-unknown',
        status:'status_unknown', task_status:'status_unknown', task_deadline_at_utc_msc:120_000 }])
      await recoverManualAnalysisJobs()
      expect(markModelTaskCompletedStaleById).toHaveBeenCalledWith('task-unknown',
        'manual_analysis_status_unknown_deadline_expired', expect.objectContaining({ requireDeadlineReached:true }))
      expect(queryRun).toHaveBeenCalledWith(expect.stringContaining('UPDATE ai_manual_analysis_jobs SET'),
        expect.arrayContaining(['completed_stale']))
    } finally { vi.useRealTimers() }
  })

  it('restores an already committed signal using the same handleAnalyze shape', () => {
    const restored = __manualAnalysisJobsTest.restoreSignalFromRow({
      id:88, user_id:9, signal_type:'buy', confidence:'0.82', recommended_volume:'0.01', is_executed:1,
      analysis:'analysis', reasoning:'reasoning', decision_json:'{"entry_method":"market","position_size_tier":"light"}',
      market_data_json:'{"latest_price":1234}', execution_result:'{"status":"success"}',
    })
    expect(restored).toMatchObject({ id:88, signal_type:'buy', confidence:0.82, recommended_volume:0.01,
      is_executed:true, entry_method:'market', position_size_tier:'light',
      market_data:{ latest_price:1234 }, execution_result:{ status:'success' } })
  })

  it('cancels under the job lock and never cancels a signal that already committed', async () => {
    const row = { job_id:'job-cancel', user_id:9, model_task_id:'task-cancel', status:'running', cancel_requested:0,
      params_json:'{}', strategy_id:7, strategy_version:1, created_at_utc_msc:1 }
    queryOne.mockResolvedValueOnce({ ...row, status:'cancelled', cancel_requested:1 })
    const run = vi.fn(async sql => {
      if (sql.includes('SELECT * FROM ai_manual_analysis_jobs')) return [[row]]
      if (sql.includes('SELECT * FROM ai_signals')) return [[]]
      return [{ affectedRows:1 }]
    })
    withTransaction.mockImplementation(async callback => callback(run))
    cancelModelTaskById.mockResolvedValue(true)
    const job = await (await import('../../server/routes/ai/manual-analysis-jobs.js')).cancelManualAnalysisJob(9, 'job-cancel')
    expect(job.status).toBe('cancelled')
    expect(cancelModelTaskById).toHaveBeenCalledWith('task-cancel', 'manual_analysis_cancelled')
    expect(run.mock.calls.findIndex(([sql]) => sql.includes('ai_manual_analysis_jobs')))
      .toBeLessThan(run.mock.calls.findIndex(([sql]) => sql.includes('ai_signals')))
  })

  it('keeps a committed signal as succeeded when DELETE loses the race', async () => {
    const row = { job_id:'job-race', user_id:9, model_task_id:'task-race', status:'running', cancel_requested:0,
      params_json:'{}', strategy_id:7, strategy_version:1, created_at_utc_msc:1 }
    const signal = { id:90, user_id:9, signal_type:'hold', confidence:'0.5', decision_json:'{}', market_data_json:'{}' }
    queryOne.mockResolvedValueOnce({ ...row, status:'succeeded', result_json:'{"status":"success"}' })
    const run = vi.fn(async sql => {
      if (sql.includes('SELECT * FROM ai_manual_analysis_jobs')) return [[row]]
      if (sql.includes('SELECT * FROM ai_signals')) return [[signal]]
      return [{ affectedRows:0 }]
    })
    withTransaction.mockImplementation(async callback => callback(run))
    const job = await (await import('../../server/routes/ai/manual-analysis-jobs.js')).cancelManualAnalysisJob(9, 'job-race')
    expect(job.status).toBe('succeeded')
    expect(cancelModelTaskById).not.toHaveBeenCalled()
  })
})
