import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  createModelTask:vi.fn(), claimModelTaskById:vi.fn(), transitionModelTask:vi.fn(),
  renewModelTaskLease:vi.fn(), beginModelTaskAttempt:vi.fn(), finishModelTaskAttempt:vi.fn(),
  persistModelTaskBudget:vi.fn(), succeedModelTaskInTransaction:vi.fn(), touchModelTaskActivity:vi.fn(),
}))

vi.mock('../../server/routes/ai/model-task-runtime.js', () => runtime)

import { createModelTaskTracker } from '../../server/routes/ai/model-task-tracker.js'

function setupRuntime() {
  const leased = { task_id:'task-1', status:'leased', lease_token:'lease-1', fencing_token:1, attempt_count:1 }
  runtime.createModelTask.mockResolvedValue({
    created:true,
    task:{ task_id:'task-1', status:'queued', scheduled_at_utc_msc:Date.now() - 1 },
  })
  runtime.claimModelTaskById.mockResolvedValue(leased)
  runtime.transitionModelTask.mockImplementation(async (task, status) => ({ ...task, status }))
  runtime.renewModelTaskLease.mockResolvedValue(true)
  runtime.beginModelTaskAttempt.mockResolvedValue({ id:11, task_id:'task-1', attempt_no:1, fencing_token:1 })
  runtime.finishModelTaskAttempt.mockResolvedValue(undefined)
  runtime.persistModelTaskBudget.mockImplementation(async (task, budget) => ({ ...task, ...budget }))
  runtime.succeedModelTaskInTransaction.mockImplementation(async (_run, task, patch) => ({
    ...task, ...patch, status:'succeeded', result_ref:patch.resultRef, result_hash:patch.resultHash,
  }))
  runtime.touchModelTaskActivity.mockResolvedValue(undefined)
}

describe('authoritative model task tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupRuntime()
  })

  it('fails closed during initialization instead of returning a noop tracker', async () => {
    const initError = new Error('event_insert_failed')
    runtime.createModelTask.mockRejectedValueOnce(initError)
    await expect(createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:1' }))
      .rejects.toThrow('event_insert_failed')
    expect(runtime.claimModelTaskById).not.toHaveBeenCalled()
  })

  it('serializes a fenced budget write before provider callbacks', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:budget' }, { renewIntervalMs:60_000 })
    await tracker.persistBudget({ estimatedInputTokens:100, selectedMaxOutputTokens:200, contextWindowTokens:4096 })
    expect(runtime.persistModelTaskBudget).toHaveBeenCalledWith(expect.objectContaining({
      task_id:'task-1', lease_token:'lease-1', fencing_token:1,
    }), expect.objectContaining({ selectedMaxOutputTokens:200 }))
    await tracker.stop()
  })

  it('updates local tracker state only after the caller confirms its transaction committed', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:tx-success' }, { renewIntervalMs:60_000 })
    await tracker.onProviderRequest({ phase:'request' })
    await tracker.onProviderUsage({ phase:'request', status:'success', httpStatus:200, responseReceived:true })
    await tracker.resultReady({ resultHash:'hash-1' })
    await tracker.applying()
    const run = vi.fn()
    await tracker.succeedInTransaction(run, { resultRef:'review:1', resultHash:'hash-1' })
    expect(runtime.succeedModelTaskInTransaction).toHaveBeenCalledWith(run,
      expect.objectContaining({ status:'applying' }), { resultRef:'review:1', resultHash:'hash-1' })
    expect(tracker.status).toBe('applying')
    await tracker.commitTransactionSucceeded()
    expect(tracker.status).toBe('succeeded')
    await tracker.stop()
  })

  it('remembers lease renewal failure and surfaces it through ownership and stop', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:2' }, { renewIntervalMs:60_000 })
    runtime.renewModelTaskLease.mockResolvedValueOnce(false)
    await expect(tracker.renewNow()).rejects.toThrow('model_task_lease_lost')
    expect(() => tracker.assertOwned()).toThrow('model_task_lease_lost')
    await expect(tracker.stop()).rejects.toThrow('model_task_lease_lost')
  })

  it('drains a renewal queued behind success without turning the terminal task into lease loss', async () => {
    let releaseSuccess
    const successGate = new Promise(resolve => { releaseSuccess = resolve })
    runtime.transitionModelTask.mockImplementation(async (task, status) => {
      if (status === 'succeeded') await successGate
      return { ...task, status }
    })
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:terminal-renew' }, {
      renewIntervalMs:60_000,
    })
    const succeeded = tracker.succeeded({ resultRef:'review:1' })
    await vi.waitFor(() => expect(runtime.transitionModelTask)
      .toHaveBeenCalledWith(expect.any(Object), 'succeeded', { resultRef:'review:1' }))
    const queuedRenewal = tracker.renewNow()
    releaseSuccess()
    await succeeded
    const stopped = tracker.stop()
    await expect(queuedRenewal).resolves.toBe(true)
    await expect(stopped).resolves.toBeUndefined()
    expect(runtime.renewModelTaskLease).not.toHaveBeenCalled()
    expect(tracker.status).toBe('succeeded')
  })

  it('rejects an existing active idempotent task before a second provider request can start', async () => {
    const requestModel = vi.fn()
    runtime.createModelTask.mockResolvedValueOnce({
      created:false,
      task:{ task_id:'task-existing', status:'provider_running' },
    })
    await expect(createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:existing' }))
      .rejects.toThrow('model_task_duplicate_active')
    expect(runtime.claimModelTaskById).not.toHaveBeenCalled()
    expect(requestModel).not.toHaveBeenCalled()
  })

  it('does not swallow a fencing/event failure from a provider callback', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:3' }, { renewIntervalMs:60_000 })
    runtime.transitionModelTask.mockRejectedValueOnce(new Error('model_task_fence_lost'))
    await expect(tracker.onProviderRequest({ phase:'request' })).rejects.toThrow('model_task_fence_lost')
    expect(tracker.signal.aborted).toBe(true)
    await expect(tracker.stop()).rejects.toThrow('model_task_fence_lost')
  })

  it('marks a post-submit network loss status unknown and never retry_wait', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:network-unknown' }, { renewIntervalMs:60_000 })
    await tracker.onProviderRequest({ phase:'request' })
    await tracker.failed(Object.assign(new Error('fetch failed'), { code:'fetch_failed' }), false)

    const statuses = runtime.transitionModelTask.mock.calls.map(([, status]) => status)
    expect(statuses).toEqual(['preparing', 'submitted', 'status_unknown'])
    expect(tracker.status).toBe('status_unknown')
    expect(tracker.providerRequestState).toMatchObject({ submitted:true, responseReceived:false, providerRequestId:null })
    await tracker.stop()
  })

  it('uses provider_quiet when a lost response has a provider request id', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:provider-quiet' }, { renewIntervalMs:60_000 })
    await tracker.onProviderRequest({ phase:'request' })
    await tracker.onProviderUsage({ phase:'request', status:'error', providerRequestId:'req-quiet' })
    await tracker.failed(new Error('connection lost'), false)

    const statuses = runtime.transitionModelTask.mock.calls.map(([, status]) => status)
    expect(statuses).toEqual(['preparing', 'submitted', 'provider_quiet'])
    expect(tracker.status).toBe('provider_quiet')
    expect(tracker.providerRequestState).toMatchObject({ submitted:true, responseReceived:false, providerRequestId:'req-quiet' })
    await tracker.stop()
  })

  it('lets only the auto-inference opt-in terminalize a response-less provider failure', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'auto_inference', idempotencyKey:'auto:provider-failed' }, {
      renewIntervalMs:60_000,
    })
    await tracker.onProviderRequest({ phase:'request', providerRequestId:'req-auto-failed' })
    await tracker.failed(new Error('fetch failed'), true, { terminalOnFailure:true })

    expect(tracker.status).toBe('failed_terminal')
    expect(runtime.transitionModelTask.mock.calls.map(([, status]) => status))
      .toEqual(['preparing', 'submitted', 'failed_terminal'])
    await tracker.stop()

    const unknownTracker = await createModelTaskTracker({ taskKind:'auto_inference', idempotencyKey:'auto:unknown-failed' }, {
      renewIntervalMs:60_000,
    })
    await unknownTracker.onProviderRequest({ phase:'request' })
    await unknownTracker.failed(new Error('fetch failed'), true, { terminalOnFailure:true })
    expect(unknownTracker.status).toBe('failed_terminal')
    await unknownTracker.stop()

    const manualTracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'manual:provider-failed' }, {
      renewIntervalMs:60_000,
    })
    await manualTracker.onProviderRequest({ phase:'request', providerRequestId:'req-manual-failed' })
    await manualTracker.failed(new Error('fetch failed'), true, { terminalOnFailure:true })
    expect(manualTracker.status).toBe('provider_quiet')
    await manualTracker.stop()
  })

  it('maps explicit HTTP 429 to controlled retry_wait and terminal after exhaustion', async () => {
    const retryTracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:http-429-retry' }, { renewIntervalMs:60_000 })
    await retryTracker.onProviderRequest({ phase:'request' })
    await retryTracker.onProviderUsage({ phase:'request', status:'error', httpStatus:429, responseReceived:true })
    const providerError = Object.assign(new Error('rate limited'), { providerStatus:429, code:'model_quota_exhausted' })
    await retryTracker.failed(providerError, false)
    expect(retryTracker.status).toBe('retry_wait')
    await retryTracker.stop()

    const terminalTracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:http-429-terminal' }, { renewIntervalMs:60_000 })
    await terminalTracker.onProviderRequest({ phase:'request' })
    await terminalTracker.onProviderUsage({ phase:'request', status:'error', httpStatus:429, responseReceived:true })
    await terminalTracker.failed(providerError, true)
    expect(terminalTracker.status).toBe('failed_terminal')
    await terminalTracker.stop()
  })

  it('keeps full-response validation failures on the existing controlled retry path', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:validation-retry' }, { renewIntervalMs:60_000 })
    await tracker.onProviderRequest({ phase:'request' })
    await tracker.onProviderUsage({ phase:'request', status:'success', httpStatus:200, responseReceived:true })
    await tracker.failed(Object.assign(new Error('invalid_output'), { code:'invalid_output' }), false)
    expect(tracker.status).toBe('retry_wait')
    await tracker.stop()
  })

  it('records quiet and resumed provider states before accepting a terminal response', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:activity' }, { renewIntervalMs:60_000 })
    await tracker.onProviderRequest({ phase:'request' })
    await tracker.onProviderQuiet({ phase:'request' })
    expect(tracker.status).toBe('provider_quiet')
    await tracker.onProviderActivity({ phase:'request', state:'response_headers', providerRequestId:'req-activity' })
    expect(tracker.status).toBe('provider_running')
    await tracker.onProviderUsage({ phase:'request', status:'success', httpStatus:200,
      responseReceived:true, providerRequestId:'req-activity' })
    expect(tracker.status).toBe('response_received')
    expect(runtime.transitionModelTask.mock.calls.map(([, status]) => status))
      .toEqual(['preparing', 'submitted', 'provider_quiet', 'provider_running', 'response_received'])
    await tracker.stop()
  })

  it('persists the first provider byte immediately and throttles later activity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:activity-touch' }, { renewIntervalMs:60_000 })
      await tracker.onProviderRequest({ phase:'request' })
      await tracker.onProviderActivity({ phase:'request', state:'provider_event', firstByte:true })
      await tracker.onProviderActivity({ phase:'request', state:'provider_event', firstByte:true })
      await tracker.onProviderActivity({ phase:'request', state:'provider_event', firstByte:false })
      expect(runtime.touchModelTaskActivity).toHaveBeenCalledTimes(1)
      expect(runtime.touchModelTaskActivity.mock.calls[0][1]).toMatchObject({ id:11 })
      expect(runtime.touchModelTaskActivity.mock.calls[0][2]).toMatchObject({ firstByte:true, lastActivityAtUtcMs:10_000 })
      vi.setSystemTime(15_001)
      await tracker.onProviderActivity({ phase:'request', state:'provider_event', firstByte:false })
      expect(runtime.touchModelTaskActivity).toHaveBeenCalledTimes(2)
      expect(runtime.touchModelTaskActivity.mock.calls[1][2]).toMatchObject({ firstByte:false, lastActivityAtUtcMs:15_001 })
      await tracker.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fences the worker when the activity touch fails', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:activity-fence' }, { renewIntervalMs:60_000 })
    await tracker.onProviderRequest({ phase:'request' })
    runtime.touchModelTaskActivity.mockRejectedValueOnce(new Error('model_task_fence_lost'))
    await expect(tracker.onProviderActivity({ phase:'request', firstByte:true })).rejects.toThrow('model_task_fence_lost')
    expect(tracker.signal.aborted).toBe(true)
    await expect(tracker.stop()).rejects.toThrow('model_task_fence_lost')
  })
})
