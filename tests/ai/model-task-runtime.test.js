import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryRun = vi.fn()
const mockQueryOne = vi.fn()
const mockQueryAll = vi.fn()
vi.mock('../../server/db.js', () => ({
  queryRun:(...args) => mockQueryRun(...args),
  queryOne:(...args) => mockQueryOne(...args),
  queryAll:(...args) => mockQueryAll(...args),
  withTransaction:vi.fn(),
}))

import { assertModelTaskIdempotencyEnvelope, assertModelTaskTransition, canTransitionModelTask, createModelTask,
  finishModelTaskAttempt, markModelTaskCompletedStaleById, markModelTaskSucceededFromResult,
  persistModelTaskBudget,
  recoverAbandonedAutoInferenceTasks, recoverAbandonedBusinessModelTasks, renewModelTaskLease,
  touchModelTaskActivity, transitionModelTask } from '../../server/routes/ai/model-task-runtime.js'

describe('model task runtime state and fencing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows the recovery path but keeps terminal states immutable', () => {
    expect(canTransitionModelTask('submitted', 'status_unknown')).toBe(true)
    expect(canTransitionModelTask('status_unknown', 'reconciling')).toBe(true)
    expect(canTransitionModelTask('result_ready', 'applying')).toBe(true)
    expect(canTransitionModelTask('succeeded', 'applying')).toBe(false)
    expect(() => assertModelTaskTransition('succeeded', 'applying')).toThrow('invalid_model_task_transition')
  })

  it('deduplicates a business task by task kind and idempotency key', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:0 })
    mockQueryOne.mockResolvedValueOnce({ task_id:'existing', status:'provider_running' })
    const result = await createModelTask({ taskKind:'auto_inference', idempotencyKey:'strategy:7:XAUUSD:cycle:9' })
    expect(result).toEqual({ task:{ task_id:'existing', status:'provider_running' }, created:false })
    expect(mockQueryOne).toHaveBeenCalledWith(expect.stringContaining('task_kind = ? AND idempotency_key = ?'),
      ['auto_inference', 'strategy:7:XAUUSD:cycle:9'])
  })

  it('rejects an idempotent task when its frozen execution envelope changes', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:0 })
    mockQueryOne.mockResolvedValueOnce({
      task_id:'existing', status:'queued', input_hash:'old-input',
      frozen_provider:'openai', frozen_model:'model-a', frozen_model_profile_id:7,
      frozen_protocol:'chat_completions', frozen_context_json:JSON.stringify({ generation_no:2, stage:'counterfactual' }),
    })
    await expect(createModelTask({
      taskKind:'manual_analysis', idempotencyKey:'manual:19:2:counterfactual', inputHash:'new-input',
      provider:'openai', model:'model-a', modelProfileId:7, protocol:'chat_completions',
      frozenContext:{ stage:'counterfactual', generation_no:2 },
    })).rejects.toMatchObject({ code:'model_task_idempotency_conflict' })
  })

  it('accepts equivalent frozen context regardless of object key order', () => {
    expect(assertModelTaskIdempotencyEnvelope({
      input_hash:'same', frozen_context_json:'{"stage":"outcome_review","generation_no":3}',
    }, {
      inputHash:'same', frozenContext:{ generation_no:3, stage:'outcome_review' },
    })).toBe(true)
  })

  it('keeps historical null envelope fields compatible', () => {
    expect(assertModelTaskIdempotencyEnvelope({
      task_id:'legacy', input_hash:null, frozen_provider:null, frozen_context_json:null,
    }, {
      inputHash:'new-hash', provider:'openai', frozenContext:{ generation_no:1 },
    })).toBe(true)
  })

  it('renews a lease only with the exact token and fencing generation', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 })
    await expect(renewModelTaskLease({ task_id:'task-1', lease_token:'lease-1', fencing_token:4 }, 120000)).resolves.toBe(true)
    expect(mockQueryRun.mock.calls[0][1].slice(-3)).toEqual(['task-1', 'lease-1', 4])
  })

  it('persists the selected budget only for the current lease and fencing generation', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 }).mockResolvedValueOnce({ affectedRows:1 })
    const task = { task_id:'task-budget', status:'preparing', lease_token:'lease-budget', fencing_token:8 }
    await expect(persistModelTaskBudget(task, {
      estimatedInputTokens:321, selectedMaxOutputTokens:2048, schemaNeedTokens:1500,
      contextWindowTokens:16384, providerOutputCap:4096, providerMaxInputTokens:12000,
      contextLimitSemantics:'shared_context', tokenLimitsSource:'manual_confirmed',
      tokenLimitsStatus:'confirmed', tokenLimitsUpdatedAtUtcMs:123456,
    })).resolves.toMatchObject({ estimatedInputTokens:321, selectedMaxOutputTokens:2048,
      providerMaxInputTokens:12000, maxInputTokens:12000, contextLimitSemantics:'shared_context',
      tokenLimitsSource:'manual_confirmed', tokenLimitsStatus:'confirmed', tokenLimitsUpdatedAtUtcMs:123456 })
    expect(mockQueryRun.mock.calls[0][0]).toContain('estimated_input_tokens = ?')
    expect(mockQueryRun.mock.calls[0][0]).toContain('provider_max_input_tokens = ?')
    expect(mockQueryRun.mock.calls[0][0]).toContain('token_limits_status = ?')
    expect(mockQueryRun.mock.calls[0][0]).toContain('task_id = ? AND lease_token = ? AND fencing_token = ?')
    expect(mockQueryRun.mock.calls[0][1].slice(-3)).toEqual(['task-budget', 'lease-budget', 8])
    expect(mockQueryRun.mock.calls[1][1]).toContain('budget_persisted')
  })

  it('fails closed when the fenced budget update affects no row', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:0 })
    await expect(persistModelTaskBudget({ task_id:'task-stale', lease_token:'old', fencing_token:2 }, {
      estimatedInputTokens:1, selectedMaxOutputTokens:2,
    })).rejects.toThrow('model_task_fence_lost')
    expect(mockQueryRun).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing output budget before touching the task row', async () => {
    await expect(persistModelTaskBudget({ task_id:'task-budget' }, {
      estimatedInputTokens:100, selectedMaxOutputTokens:0,
    })).rejects.toThrow('model_task_budget_invalid')
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('writes request and response bytes when finishing an attempt', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 }).mockResolvedValueOnce({ affectedRows:1 })
    await expect(finishModelTaskAttempt(
      { task_id:'task-bytes', fencing_token:5 }, { id:19 },
      { status:'succeeded', requestBytes:1234, responseBytes:5678, inputTokens:12, outputTokens:34 },
    )).resolves.toBeUndefined()
    expect(mockQueryRun.mock.calls[0][0]).toContain('request_bytes = ?, response_bytes = ?')
    expect(mockQueryRun.mock.calls[0][1]).toContain(1234)
    expect(mockQueryRun.mock.calls[0][1]).toContain(5678)
  })

  it('touches provider activity only for the current attempt and task fencing generation', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 }).mockResolvedValueOnce({ affectedRows:1 })
    await expect(touchModelTaskActivity(
      { task_id:'task-live', lease_token:'lease-live', fencing_token:7 }, { id:31 },
      { firstByte:true, lastActivityAtUtcMs:12_345 },
    )).resolves.toEqual({ firstByte:true, lastActivityAtUtcMs:12_345 })
    expect(mockQueryRun.mock.calls[0][0]).toContain('first_byte_at_utc_msc')
    expect(mockQueryRun.mock.calls[0][1].slice(-3)).toEqual([31, 'task-live', 7])
    expect(mockQueryRun.mock.calls[1][0]).toContain('lease_token = ? AND fencing_token = ?')
    expect(mockQueryRun.mock.calls[1][1].slice(-3)).toEqual(['task-live', 'lease-live', 7])
  })

  it('fails closed before refreshing the task when the attempt activity fence is lost', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:0 })
    await expect(touchModelTaskActivity(
      { task_id:'task-stale', lease_token:'old-lease', fencing_token:2 }, { id:32 },
      { firstByte:true, lastActivityAtUtcMs:22_000 },
    )).rejects.toThrow('model_task_attempt_fence_lost')
    expect(mockQueryRun).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale worker result when the fencing update affects no row', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:0 })
    await expect(transitionModelTask({ task_id:'task-1', status:'result_ready', lease_token:'old', fencing_token:3 },
      'applying')).rejects.toThrow('model_task_fence_lost')
    expect(mockQueryRun).toHaveBeenCalledTimes(1)
  })

  it('reconciles a durable result without re-running the worker', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 }).mockResolvedValueOnce({ affectedRows:1 })
    await expect(markModelTaskSucceededFromResult('task-1', {
      resultRef:'ai_signals:88', resultHash:'hash-88',
    })).resolves.toBe(true)
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='succeeded'")
    expect(mockQueryRun.mock.calls[0][0]).toContain('lease_owner=NULL')
  })

  it('can fail closed as stale from an intermediate state', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 }).mockResolvedValueOnce({ affectedRows:1 })
    await expect(markModelTaskCompletedStaleById('task-2', 'manual_analysis_model_stale')).resolves.toBe(true)
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='completed_stale'")
    expect(mockQueryRun.mock.calls[0][1]).toContain('manual_analysis_model_stale')
  })

  it('reconciles an applied auto inference instead of requesting the model again', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'task-applied', status:'applying',
      lease_expires_at_utc_msc:1, task_deadline_at_utc_msc:200_000 }])
    mockQueryOne.mockResolvedValueOnce({ id:88 })
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    await expect(recoverAbandonedAutoInferenceTasks({ nowUtcMs:100_000 })).resolves.toEqual({
      scanned:1, succeeded:1, statusUnknown:0, stale:0, active:0,
    })
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='succeeded'")
    expect(mockQueryRun.mock.calls[0][1]).toContain('ai_signals:88')
  })

  it('marks an interrupted submitted auto request unknown and never resets it to queued', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'task-submitted', status:'submitted',
      lease_expires_at_utc_msc:90_000, task_deadline_at_utc_msc:200_000 }])
    mockQueryOne.mockResolvedValueOnce(null)
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    await expect(recoverAbandonedAutoInferenceTasks({ nowUtcMs:100_000 })).resolves.toEqual({
      scanned:1, succeeded:0, statusUnknown:1, stale:0, active:0,
    })
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='status_unknown'")
    expect(mockQueryRun.mock.calls[0][0]).not.toContain("status='queued'")
    expect(mockQueryRun.mock.calls[0][0]).toContain('fencing_token = ?')
    expect(mockQueryRun.mock.calls[0][0]).toContain('lease_expires_at_utc_msc')
  })

  it('expires an unresolved auto request as stale after its task deadline', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'task-unknown', status:'status_unknown',
      lease_expires_at_utc_msc:null, task_deadline_at_utc_msc:99_000 }])
    mockQueryOne.mockResolvedValueOnce(null)
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    const result = await recoverAbandonedAutoInferenceTasks({ nowUtcMs:100_000 })
    expect(result.stale).toBe(1)
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='completed_stale'")
  })

  it('does not touch a healthy linked task lease during business recovery', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'healthy', status:'submitted',
      lease_expires_at_utc_msc:200_000, task_deadline_at_utc_msc:300_000, provider_attempt_started:1 }])

    await expect(recoverAbandonedBusinessModelTasks({ taskKinds:['period_review_job'], nowUtcMs:100_000,
      inspectBusiness:vi.fn().mockResolvedValue({ job:{ id:1 }, succeeded:false }) }))
      .resolves.toMatchObject({ scanned:1, active:1, statusUnknown:0, stale:0 })
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('requeues an expired leased task only when no provider attempt exists', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'preparing', status:'preparing',
      lease_expires_at_utc_msc:90_000, task_deadline_at_utc_msc:300_000, provider_attempt_started:0 }])
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    await expect(recoverAbandonedBusinessModelTasks({ nowUtcMs:100_000,
      inspectBusiness:vi.fn().mockResolvedValue({ job:{ id:1 }, succeeded:false }) }))
      .resolves.toMatchObject({ requeued:1, statusUnknown:0, stale:0 })
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='queued'")
    expect(mockQueryRun.mock.calls[0][0]).toContain("status IN ('leased','preparing')")
    expect(mockQueryRun.mock.calls[1][1][2]).toBe('task_requeued_after_recovery')
  })

  it('marks a lost provider request unknown instead of requeuing it', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'submitted', status:'submitted',
      lease_expires_at_utc_msc:90_000, task_deadline_at_utc_msc:300_000, provider_attempt_started:1 }])
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    await expect(recoverAbandonedBusinessModelTasks({ nowUtcMs:100_000,
      inspectBusiness:vi.fn().mockResolvedValue({ job:{ id:1 }, succeeded:false }) }))
      .resolves.toMatchObject({ requeued:0, statusUnknown:1, stale:0 })
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='status_unknown'")
    expect(mockQueryRun.mock.calls[0][0]).not.toContain("status='queued'")
  })

  it('treats an expired preparing task with an attempt record as unknown, never stale or queued', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'preparing-requested', status:'preparing',
      lease_expires_at_utc_msc:90_000, task_deadline_at_utc_msc:300_000, fencing_token:2,
      provider_attempt_started:1 }])
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    await expect(recoverAbandonedBusinessModelTasks({ nowUtcMs:100_000,
      inspectBusiness:vi.fn().mockResolvedValue({ job:{ id:1 }, succeeded:false }) }))
      .resolves.toMatchObject({ requeued:0, statusUnknown:1, stale:0 })
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='status_unknown'")
    expect(mockQueryRun.mock.calls[0][0]).toContain("'leased','preparing','submitted'")
  })

  it('does not update the business job when the lease is renewed after inspection', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'renewed', status:'submitted',
      lease_expires_at_utc_msc:90_000, task_deadline_at_utc_msc:300_000, fencing_token:7, provider_attempt_started:1 }])
    mockQueryRun.mockResolvedValue({ affectedRows:0 })
    const onBusinessTransition = vi.fn()

    await expect(recoverAbandonedBusinessModelTasks({ nowUtcMs:100_000,
      inspectBusiness:vi.fn().mockResolvedValue({ job:{ id:3 }, succeeded:false }), onBusinessTransition }))
      .resolves.toMatchObject({ statusUnknown:0, stale:0, requeued:0 })
    expect(onBusinessTransition).not.toHaveBeenCalled()
  })

  it('stales an unresolved intermediate result and reconciles a proven business success', async () => {
    mockQueryAll.mockResolvedValueOnce([
      { task_id:'result-ready', status:'result_ready', lease_expires_at_utc_msc:90_000,
        task_deadline_at_utc_msc:300_000, provider_attempt_started:1 },
      { task_id:'applied', status:'applying', lease_expires_at_utc_msc:90_000,
        task_deadline_at_utc_msc:300_000, provider_attempt_started:1 },
    ])
    mockQueryRun.mockResolvedValue({ affectedRows:1 })
    const inspectBusiness = vi.fn()
      .mockResolvedValueOnce({ job:{ id:1 }, succeeded:false })
      .mockResolvedValueOnce({ job:{ id:2 }, succeeded:true, resultRef:'period_review_case:2', resultHash:'hash-2' })

    await expect(recoverAbandonedBusinessModelTasks({ nowUtcMs:100_000, inspectBusiness }))
      .resolves.toMatchObject({ succeeded:1, stale:1 })
    expect(mockQueryRun.mock.calls.some(([sql]) => sql.includes("status='completed_stale'"))).toBe(true)
    expect(mockQueryRun.mock.calls.some(([, params]) => params?.includes('period_review_case:2'))).toBe(true)
  })

  it('stales status_unknown only after the frozen deadline', async () => {
    mockQueryAll.mockResolvedValueOnce([{ task_id:'unknown', status:'status_unknown',
      lease_expires_at_utc_msc:null, task_deadline_at_utc_msc:99_000, provider_attempt_started:1 }])
    mockQueryRun.mockResolvedValue({ affectedRows:1 })

    await expect(recoverAbandonedBusinessModelTasks({ nowUtcMs:100_000,
      inspectBusiness:vi.fn().mockResolvedValue({ job:{ id:1 }, succeeded:false }) }))
      .resolves.toMatchObject({ stale:1, statusUnknown:0 })
    expect(mockQueryRun.mock.calls[0][0]).toContain("status='completed_stale'")
  })
})
