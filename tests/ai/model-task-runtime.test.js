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

import { assertModelTaskTransition, canTransitionModelTask, createModelTask,
  markModelTaskCompletedStaleById, markModelTaskSucceededFromResult,
  renewModelTaskLease, transitionModelTask } from '../../server/routes/ai/model-task-runtime.js'

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

  it('renews a lease only with the exact token and fencing generation', async () => {
    mockQueryRun.mockResolvedValueOnce({ affectedRows:1 })
    await expect(renewModelTaskLease({ task_id:'task-1', lease_token:'lease-1', fencing_token:4 }, 120000)).resolves.toBe(true)
    expect(mockQueryRun.mock.calls[0][1].slice(-3)).toEqual(['task-1', 'lease-1', 4])
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
})
