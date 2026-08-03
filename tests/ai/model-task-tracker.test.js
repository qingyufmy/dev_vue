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
})
