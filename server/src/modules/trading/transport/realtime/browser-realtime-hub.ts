import type { BrowserRealtimeEvent, TradingReadRepository } from '../../application/trading-ports.js'

export interface BrowserRealtimeSink {
  send(message: unknown): void
  close(code: number, reason: string): void
}

export interface BrowserRealtimeTarget {
  accountId: string | null
  observerChannelId: string | null
  resources: string[]
  afterRevision: Record<string, number | null>
  publicTarget: Record<string, unknown>
}

interface AuthorizedTarget extends BrowserRealtimeTarget {
  revisions: Record<string, number>
}

interface Subscription {
  userId: number
  targets: AuthorizedTarget[]
  sink: BrowserRealtimeSink
  sequence: number
}

const PLATFORM_RESOURCES = new Set(['macro_snapshot', 'calendar_event'])
const USER_RESOURCES = new Set(['analysis.job', 'market_analysis', 'review_case', 'strategy_memory', 'operation', 'audit', ...PLATFORM_RESOURCES])
const DOMAIN_RESOURCES = new Set([
  ...USER_RESOURCES, 'trader.job', 'trade_decision', 'risk.policy', 'risk.summary',
  'risk.decision', 'risk.manual_release', 'operation',
  'trade_history', ...PLATFORM_RESOURCES,
])

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
    return this.subscribeTargets({
      userId: input.userId,
      sink: input.sink,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      targets: [{
        accountId: input.accountId,
        observerChannelId: input.observerChannelId ?? null,
        resources: input.resources,
        afterRevision: input.afterRevision,
        publicTarget: targetForResources(input.resources, input.accountId, input.observerChannelId ?? null),
      }],
    })
  }

  async subscribeTargets(input: {
    userId: number
    requestId?: string
    targets: BrowserRealtimeTarget[]
    sink: BrowserRealtimeSink
  }) {
    const authorized: AuthorizedTarget[] = []
    const accounts = new Set<string>()
    for (const target of input.targets) {
      if (target.accountId === null) {
        if (target.observerChannelId || target.resources.some(resource => !USER_RESOURCES.has(resource))) {
          input.sink.close(4403, 'realtime_scope_forbidden')
          return null
        }
      } else {
        if (target.observerChannelId && target.resources.some(resource => DOMAIN_RESOURCES.has(resource))) {
          input.sink.close(4403, 'realtime_scope_forbidden')
          return null
        }
        const key = `${target.accountId}:${target.observerChannelId ?? ''}`
        if (!accounts.has(key)) {
          if (!await this.authorizeAccount(input.userId, target.accountId, target.observerChannelId)) {
            input.sink.close(4403, 'trading_account_forbidden')
            return null
          }
          accounts.add(key)
        }
      }
      const revisions: Record<string, number> = {}
      for (const resource of target.resources) {
        const after = target.afterRevision[resource]
        if (DOMAIN_RESOURCES.has(resource)) {
          if (after !== null && after !== undefined) {
            input.sink.send({
              v: 4, type: 'subscription.resync_required', request_id: input.requestId ?? 'subscribe',
              targets: [target.publicTarget], reason: 'revision_unknown',
            })
            return null
          }
          revisions[resource] = 0
          continue
        }
        const [kind, ...parts] = resource.split(':')
        const id = parts.join(':') || 'current'
        const current = await this.repository.latestRevision(target.accountId!, kind as never, id)
        revisions[resource] = current
        if (after !== null && after !== undefined && after !== current) {
          input.sink.send({
            v: 4, type: 'subscription.resync_required', request_id: input.requestId ?? 'subscribe',
            targets: [{ ...target.publicTarget, after_revision: String(current) }], reason: 'revision_gap',
          })
          return null
        }
      }
      authorized.push({ ...target, revisions })
    }
    const subscription: Subscription = { userId: input.userId, targets: authorized, sink: input.sink, sequence: 0 }
    this.subscriptions.add(subscription)
    input.sink.send({
      v: 4,
      type: 'subscription.ready',
      request_id: input.requestId ?? 'subscribe',
      subscriptions: authorized.flatMap((target, targetIndex) => target.resources.map((resource, resourceIndex) => ({
        subscription_id: `${targetIndex + 1}:${resourceIndex + 1}:${resource}`,
        target: { ...target.publicTarget, after_revision: DOMAIN_RESOURCES.has(resource) ? null : String(target.revisions[resource] ?? 0) },
        revision: String(target.revisions[resource] ?? 0),
      }))),
    })
    return () => this.subscriptions.delete(subscription)
  }

  publish(event: BrowserRealtimeEvent) {
    for (const subscription of this.subscriptions) {
      const target = subscription.targets.find(value => targetMatches(value, subscription.userId, event))
      if (!target) continue
      subscription.sequence += 1
      subscription.sink.send({
        v: 4, event_id: event.eventId, type: event.type, occurred_at: event.occurredAt,
        sequence: subscription.sequence,
        scope: {
          user_id: String(subscription.userId), trading_account_id: event.accountId,
          terminal_instance_id: event.terminalInstanceId, observer_channel_id: event.accountId === null ? null : target.observerChannelId,
        },
        resource: { kind: event.resource, id: event.resourceId }, revision: String(event.revision),
        data: event.data, correlation_id: null,
      })
    }
  }

  private async authorizeAccount(userId: number, accountId: string, observerChannelId: string | null) {
    const channel = observerChannelId
      ? (await this.repository.listObserverChannels(userId)).find(value => value.id === observerChannelId && value.active && value.sourceAccountId === accountId)
      : null
    if (observerChannelId && !channel) return false
    const account = channel ? await this.repository.findAccount(accountId) : await this.repository.findOwnedAccount(userId, accountId)
    return Boolean(account)
  }
}

function targetMatches(target: AuthorizedTarget, userId: number, event: BrowserRealtimeEvent) {
  const key = `${event.resource}:${event.resourceId}`
  if (!target.resources.includes(key) && !target.resources.includes(event.resource)) return false
  if (PLATFORM_RESOURCES.has(event.resource)) return event.userId === null && target.accountId === null && target.observerChannelId === null
  if (event.accountId === null) return target.accountId === null && target.observerChannelId === null && event.userId === userId
  if (target.accountId !== event.accountId) return false
  return target.observerChannelId !== null || event.userId === userId
}

function targetForResources(resources: string[], accountId: string, observerChannelId: string | null) {
  const resource = resources[0] ?? 'positions:open'
  const [kind, ...parts] = resource.split(':')
  const market = kind === 'market.quote' || kind === 'market.candle'
  const resourceId = kind === 'runtime.bridge' ? 'bridge'
    : kind === 'account.metrics' ? 'metrics'
      : kind === 'positions' ? 'positions'
        : kind === 'pending_orders' ? 'pending_orders'
          : parts.join(':') || null
  return {
    kind: market ? 'market' : kind === 'runtime.bridge' ? 'runtime' : 'account', trading_account_id: accountId,
    observer_channel_id: observerChannelId, symbol: market ? parts[0] ?? null : null,
    timeframe: kind === 'market.candle' ? parts[1] ?? null : null,
    resource_id: market ? (kind === 'market.candle' ? 'candle' : 'quote') : resourceId, after_revision: null,
  }
}
