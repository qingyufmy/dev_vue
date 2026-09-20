import { expect, it, vi } from 'vitest'
import { ReviewRecovery } from '../src/modules/reviews/application/review-recovery.js'
import { BullmqReviewRecoveryPublisher } from '../src/modules/reviews/infrastructure/bullmq-review-recovery-publisher.js'
import type { Queue } from 'bullmq'
it('coalesces sweeps and waits for in-flight publication during shutdown', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const source = { listDue: vi.fn(async () => [{ jobId: 'a', fencingToken: '0' }, { jobId: 'b', fencingToken: '0' }]) }
  const publisher = { wake: vi.fn(async () => pending) }
  const recovery = new ReviewRecovery(source, publisher)
  const a = recovery.tick(); expect(recovery.tick()).toBe(a)
  await Promise.resolve()
  let stopped = false
  const closing = recovery.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  release(); await closing; await a
  expect(publisher.wake).toHaveBeenCalledTimes(1)
  await recovery.tick(); expect(source.listDue).toHaveBeenCalledTimes(1)
})
it('moves past failed publications and revisits them after the bounded sweep wraps', async () => {
  const rows = Array.from({ length: 100 }, (_, n) => ({ jobId: String(n), fencingToken: '0' }))
  const listDue = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]).mockResolvedValueOnce(rows)
  const wake = vi.fn().mockRejectedValueOnce(new Error('redis_unavailable')).mockResolvedValue(undefined)
  const recovery = new ReviewRecovery({ listDue }, { wake })
  await expect(recovery.tick()).rejects.toThrow('redis_unavailable')
  expect(wake).toHaveBeenCalledTimes(100)
  await recovery.tick(); await recovery.tick()
  expect(listDue.mock.calls).toEqual([[null, 100], ['99', 100], [null, 100]])
})
it('uses stable per-claim wake identities and removes terminal wake records for future recovery', async () => {
  const add = vi.fn(async () => ({}))
  const publisher = new BullmqReviewRecoveryPublisher({ add } as unknown as Pick<Queue, 'add'>)
  await publisher.wake({ jobId: 'job:1', fencingToken: '0' })
  await publisher.wake({ jobId: 'job:1', fencingToken: '0' })
  await publisher.wake({ jobId: 'job:1', fencingToken: '1' })
  const calls = add.mock.calls as unknown as Array<[string, object, { jobId: string; removeOnComplete: boolean; removeOnFail: boolean }]>
  expect(calls[0]![2].jobId).toBe(calls[1]![2].jobId)
  expect(calls[0]![2].jobId).not.toBe(calls[2]![2].jobId)
  expect(calls[0]![2]).toMatchObject({ removeOnComplete: true, removeOnFail: true })
})
