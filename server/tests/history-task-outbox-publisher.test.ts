import { expect, it, vi } from 'vitest'
import { BullMqOutboxTaskPublisher } from '../src/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'

const event: ClaimedOutboxEvent = { id: '1', eventId: 'event-12345678', eventType: 'trade.history.task.requested',
  occurredAt: '2026-09-09T00:00:00.000Z', attempts: 1, payload: { task_id: '00000000-0000-4000-8000-000000000001' } }
function fixture() {
  const add = vi.fn().mockResolvedValue(undefined)
  const publisher = new BullMqOutboxTaskPublisher({ bridgeHistoryTask: { add } } as unknown as RuntimeTaskQueues)
  return { add, publisher }
}
it('publishes only the request ID with the same job ID on outbox replay', async () => {
  const { add, publisher } = fixture()
  await publisher.publish(event); await publisher.publish({ ...event, attempts: 2 })
  expect(add.mock.calls).toEqual(Array.from({ length: 2 }, () => ['trade.history.task.collect',
    { taskId: '00000000-0000-4000-8000-000000000001' }, { jobId: 'event-12345678' }]))
})
it('rejects missing request identity before queue submission', async () => {
  const { add, publisher } = fixture()
  await expect(publisher.publish({ ...event, payload: {} })).rejects.toThrow('outbox_history_task_id_invalid')
  expect(add).not.toHaveBeenCalled()
})
it('propagates queue failure so outbox is not acknowledged as dispatched', async () => {
  const { add, publisher } = fixture()
  add.mockRejectedValue(new Error('queue unavailable'))
  await expect(publisher.publish(event)).rejects.toThrow('queue unavailable')
})
it('rejects payload fields that could smuggle an account or route into the queue', async () => {
  const f = fixture()
  await expect(f.publisher.publish({ ...event, payload: { ...event.payload, account_id: '6' } })).rejects.toThrow('outbox_history_task_id_invalid')
  expect(f.add).not.toHaveBeenCalled()
})
