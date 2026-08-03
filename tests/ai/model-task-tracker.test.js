import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  createModelTask:vi.fn(), claimModelTaskById:vi.fn(), transitionModelTask:vi.fn(),
  renewModelTaskLease:vi.fn(), beginModelTaskAttempt:vi.fn(), finishModelTaskAttempt:vi.fn(),
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

  it('remembers lease renewal failure and surfaces it through ownership and stop', async () => {
    const tracker = await createModelTaskTracker({ taskKind:'daily_review', idempotencyKey:'daily:2' }, { renewIntervalMs:60_000 })
    runtime.renewModelTaskLease.mockResolvedValueOnce(false)
    await expect(tracker.renewNow()).rejects.toThrow('model_task_lease_lost')
    expect(() => tracker.assertOwned()).toThrow('model_task_lease_lost')
    await expect(tracker.stop()).rejects.toThrow('model_task_lease_lost')
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
})
