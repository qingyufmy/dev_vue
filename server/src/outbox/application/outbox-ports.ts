export interface ClaimedOutboxEvent {
  id: string
  eventId: string
  eventType: 'analysis.requested' | 'analysis.running' | 'analysis.failed' | 'market_analysis.created'
    | 'trader.requested' | 'trader.running' | 'trader.failed' | 'trade_decision.created'
    | 'risk.policy.changed' | 'risk.summary.changed' | 'risk.decision.created' | 'risk.manual_release.changed'
    | 'operation.changed' | 'execution.intent.prepared' | 'execution.distribution.target.requested' | 'bridge.command.queued'
  occurredAt: string
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
