import type { OutboxTaskPublisher, ClaimedOutboxEvent } from '../application/outbox-ports.js'
import type { RuntimeTaskQueues } from '../../queue/task-queues.js'

export class BullMqOutboxTaskPublisher implements OutboxTaskPublisher {
  constructor(private readonly queues: RuntimeTaskQueues) {}

  async publish(event: ClaimedOutboxEvent) {
    if (event.eventType === 'execution.intent.prepared') {
      const intentId = requiredId(event.payload.intent_id, 'outbox_intent_id_invalid')
      await this.queues.execution.add('execution.intent.prepare', { intentId }, { jobId: event.eventId })
      return
    }
    const commandId = requiredId(event.payload.command_id, 'outbox_command_id_invalid')
    await this.queues.bridgeDispatch.add('bridge.command.dispatch', { commandId }, { jobId: event.eventId })
  }
}

function requiredId(value: unknown, code: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(value)) throw new Error(code)
  return value
}
