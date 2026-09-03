import { randomUUID } from 'node:crypto'
import type { OutboxRepository, OutboxTaskPublisher } from './outbox-ports.js'

export class OutboxDispatcher {
  constructor(
    private readonly repository: OutboxRepository,
    private readonly publisher: OutboxTaskPublisher,
    private readonly maximumAttempts = 12,
    private readonly now = () => new Date(),
  ) {}

  async runBatch(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('outbox_limit_invalid')
    const owner = `outbox:${randomUUID()}`
    const events = await this.repository.claim(owner, limit, 30, this.now())
    let dispatched = 0
    let failed = 0
    for (const event of events) {
      try {
        await this.publisher.publish(event)
        if (!await this.repository.markDispatched(event.id, owner, this.now())) throw new Error('outbox_lease_lost')
        dispatched += 1
      } catch {
        const attempts = event.attempts
        const dead = attempts >= this.maximumAttempts
        const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8))
        await this.repository.retry(event.id, owner, new Date(this.now().getTime() + delaySeconds * 1_000), dead)
        failed += 1
      }
    }
    return { claimed: events.length, dispatched, failed }
  }
}
