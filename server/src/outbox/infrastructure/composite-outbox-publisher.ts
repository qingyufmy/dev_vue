import type { ClaimedOutboxEvent, OutboxTaskPublisher } from '../application/outbox-ports.js'

export class CompositeOutboxPublisher implements OutboxTaskPublisher {
  constructor(private readonly publishers: readonly OutboxTaskPublisher[]) {}

  async publish(event: ClaimedOutboxEvent) {
    for (const publisher of this.publishers) await publisher.publish(event)
  }
}
