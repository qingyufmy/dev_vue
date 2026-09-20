import { expect, it, vi } from 'vitest'
import { BullMqOutboxTaskPublisher } from '../src/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'

const event: ClaimedOutboxEvent = { id: '1', eventId: 'event-12345678', eventType: 'instrument.collection.requested',
  occurredAt: '2026-09-09T00:00:00.000Z', attempts: 1, payload: { request_id: 'request-12345678', account_id: '11', symbol: 'XAUUSD' } }
function fixture() {
  const add = vi.fn().mockResolvedValue(undefined)
  const publisher = new BullMqOutboxTaskPublisher({ bridgeInstrument: { add } } as unknown as RuntimeTaskQueues)
  return { add, publisher }
}
it('publishes only the request ID with the same job ID on outbox replay', async () => {
  const { add, publisher } = fixture()
  await publisher.publish(event); await publisher.publish({ ...event, attempts: 2 })
  expect(add.mock.calls).toEqual(Array.from({ length: 2 }, () => ['instrument.collection.collect',
    { requestId: 'request-12345678' }, { jobId: 'event-12345678' }]))
})
it('rejects missing request identity before queue submission', async () => {
  const { add, publisher } = fixture()
  await expect(publisher.publish({ ...event, payload: {} })).rejects.toThrow('outbox_instrument_request_id_invalid')
  expect(add).not.toHaveBeenCalled()
})
it('propagates queue failure so outbox is not acknowledged as dispatched', async () => {
  const { add, publisher } = fixture()
  add.mockRejectedValue(new Error('queue unavailable'))
  await expect(publisher.publish(event)).rejects.toThrow('queue unavailable')
})
