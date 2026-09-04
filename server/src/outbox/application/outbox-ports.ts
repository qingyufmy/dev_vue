export interface ClaimedOutboxEvent {
  id: string
  eventId: string
  eventType: 'analysis.requested' | 'trader.requested' | 'trade_decision.created' | 'risk.decision.created'
    | 'execution.intent.prepared' | 'bridge.command.queued'
  payload: Record<string, unknown>
  attempts: number
}

export interface OutboxRepository {
  claim(owner: string, limit: number, leaseSeconds: number, now: Date): Promise<ClaimedOutboxEvent[]>
  markDispatched(id: string, owner: string, now: Date): Promise<boolean>
  retry(id: string, owner: string, availableAt: Date, dead: boolean): Promise<boolean>
}

export interface OutboxTaskPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>
}
