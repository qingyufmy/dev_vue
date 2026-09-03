import type { TradingReadRepository, TradingRealtimeEvent } from '../../application/trading-ports.js'

export interface BrowserRealtimeSink {
  send(message: unknown): void
  close(code: number, reason: string): void
}

interface Subscription { userId: number; accountId: string; observerChannelId: string | null; resources: Set<string>; sink: BrowserRealtimeSink; sequence: number }

export class BrowserRealtimeHub {
  private readonly subscriptions = new Set<Subscription>()

  constructor(private readonly repository: TradingReadRepository) {}

  async subscribe(input: {
    userId: number
    accountId: string
    observerChannelId?: string | null
    requestId?: string
    resources: string[]
    afterRevision: Record<string, number | null>
    sink: BrowserRealtimeSink
  }) {
    const channel = input.observerChannelId
      ? (await this.repository.listObserverChannels(input.userId)).find((value) => value.id === input.observerChannelId && value.active && value.sourceAccountId === input.accountId)
      : null
    if (input.observerChannelId && !channel) {
      input.sink.close(4403, 'trading_account_forbidden')
      return null
    }
    const account = channel ? await this.repository.findAccount(input.accountId) : await this.repository.findOwnedAccount(input.userId, input.accountId)
    if (!account) {
      input.sink.close(4403, 'trading_account_forbidden')
      return null
    }
    const currentRevisions: Record<string, number> = {}
    for (const resource of input.resources) {
      const [kind, ...parts] = resource.split(':')
      const id = parts.join(':') || 'current'
      const current = await this.repository.latestRevision(account.id, kind as never, id)
      currentRevisions[resource] = current
      const after = input.afterRevision[resource]
      if (after !== null && after !== undefined && after !== current) {
        input.sink.send({ v: 4, type: 'subscription.resync_required', request_id: input.requestId ?? 'subscribe', targets: [target(resource, account.id, current, channel?.id ?? null)], reason: 'revision_gap' })
        return null
      }
    }
    const subscription: Subscription = {
      userId: input.userId, accountId: account.id, observerChannelId: channel?.id ?? null, resources: new Set(input.resources), sink: input.sink, sequence: 0,
    }
    this.subscriptions.add(subscription)
    input.sink.send({ v: 4, type: 'subscription.ready', request_id: input.requestId ?? 'subscribe', subscriptions: input.resources.map((resource) => ({ subscription_id: resource, target: target(resource, account.id, currentRevisions[resource] ?? 0, channel?.id ?? null), revision: String(currentRevisions[resource] ?? 0) })) })
    return () => this.subscriptions.delete(subscription)
  }

  publish(event: TradingRealtimeEvent) {
    for (const subscription of this.subscriptions) {
      const key = `${event.resource}:${event.resourceId}`
      if ((!subscription.observerChannelId && subscription.userId !== event.userId) || subscription.accountId !== event.accountId
        || (!subscription.resources.has(key) && !subscription.resources.has(event.resource))) continue
      subscription.sequence += 1
      subscription.sink.send({
        v: 4, event_id: event.eventId, type: event.type, occurred_at: event.occurredAt,
        sequence: subscription.sequence,
        scope: { user_id: String(subscription.userId), trading_account_id: event.accountId, terminal_instance_id: event.terminalInstanceId, observer_channel_id: subscription.observerChannelId },
        resource: { kind: event.resource, id: event.resourceId }, revision: String(event.revision), data: event.data, correlation_id: null,
      })
    }
  }
}

function target(resource: string, accountId: string, revision: number, observerChannelId: string | null) {
  const [kind, ...parts] = resource.split(':')
  const id = parts.join(':') || 'current'
  const market = kind === 'market.quote' || kind === 'market.candle'
  const resourceId = kind === 'runtime.bridge' ? 'bridge'
    : kind === 'account.metrics' ? 'metrics'
      : kind === 'positions' ? 'positions'
        : kind === 'pending_orders' ? 'pending_orders'
          : id
  return { kind: market ? 'market' : kind === 'runtime.bridge' ? 'runtime' : 'account', trading_account_id: accountId,
    observer_channel_id: observerChannelId, symbol: market ? parts[0] ?? null : null, timeframe: kind === 'market.candle' ? parts[1] ?? null : null, resource_id: market ? (kind === 'market.candle' ? 'candle' : 'quote') : resourceId, after_revision: String(revision) }
}
