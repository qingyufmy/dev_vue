import { createHash } from 'node:crypto'
import {
  OBSERVER_AUTHORIZATION_TTL_MS, sameObserverAuthorization,
  type ObserverAccessReader, type ObserverAuthorization,
} from '../../application/observer-ports.js'
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
  observerAuthorization?: ObserverAuthorization
}

interface ObserverPendingPublication {
  target: AuthorizedTarget
  event: {
    eventId: string
    occurredAt: string
    accountId: string
    resource: ObserverPublicationResource
    resourceId: string
    revision: number
    userId: number | null
  }
}

interface Subscription {
  userId: number
  requestId: string
  targets: AuthorizedTarget[]
  sink: BrowserRealtimeSink
  sequence: number
  closed: boolean
  observerTimer: ReturnType<typeof setTimeout> | null
  observerQueue: Map<AuthorizedTarget, ObserverPendingPublication>
  observerDraining: boolean
}

type ObserverPublicationResource = 'account.metrics' | 'market.quote' | 'market.candle' | 'positions' | 'pending_orders'

const PLATFORM_RESOURCES = new Set(['macro_snapshot', 'calendar_event'])
const USER_RESOURCES = new Set(['analysis.job', 'market_analysis', 'review_case', 'strategy_memory', 'operation', 'audit', ...PLATFORM_RESOURCES])
const DOMAIN_RESOURCES = new Set([
  ...USER_RESOURCES, 'trader.job', 'trade_decision', 'risk.policy', 'risk.summary',
  'risk.decision', 'risk.manual_release', 'operation',
  'trade_history', ...PLATFORM_RESOURCES,
])

const OBSERVER_EVENT_RESOURCES = new Map<BrowserRealtimeEvent['type'], ObserverPublicationResource>([
  ['account.metrics.changed', 'account.metrics'],
  ['market.quote.updated', 'market.quote'],
  ['market.candle.updated', 'market.candle'],
  ['market.candle.closed', 'market.candle'],
  ['positions.changed', 'positions'],
  ['pending_orders.changed', 'pending_orders'],
])

const OBSERVER_RESOURCES = new Set<ObserverPublicationResource>([
  'account.metrics', 'market.quote', 'market.candle', 'positions', 'pending_orders',
])

export class BrowserRealtimeHub {
  private readonly subscriptions = new Set<Subscription>()

  constructor(
    private readonly repository: TradingReadRepository,
    private readonly observers?: ObserverAccessReader,
    private readonly now: () => number = Date.now,
  ) {}

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
    const observerAuthorizations = new Map<string, ObserverAuthorization>()
    for (const target of input.targets) {
      const observer = target.observerChannelId !== null
      let observerAuthorization: ObserverAuthorization | undefined
      if (target.accountId === null) {
        if (observer || target.resources.some(resource => !USER_RESOURCES.has(resource))) {
          input.sink.close(4403, 'realtime_scope_forbidden')
          return null
        }
      } else {
        if (observer) {
          if (!this.observers || !isObserverTarget(target)) {
            input.sink.close(4403, 'realtime_scope_forbidden')
            return null
          }
          const authorizationKey = `${target.observerChannelId}:${target.accountId}`
          observerAuthorization = observerAuthorizations.get(authorizationKey)
          if (!observerAuthorization) {
            const channelId = target.observerChannelId!
            try {
              const result = await this.observers.authorize(input.userId, channelId, target.accountId)
              observerAuthorization = result ?? undefined
            } catch {
              observerAuthorization = undefined
            }
            if (!observerAuthorization || !validObserverAuthorization(observerAuthorization, input.userId, channelId, target.accountId, this.currentTime())) {
              input.sink.close(4403, 'trading_account_forbidden')
              return null
            }
            observerAuthorizations.set(authorizationKey, observerAuthorization)
          }
        } else {
          const historyOnly = isHistoryOnly(target)
          const key = `${target.accountId}:${target.observerChannelId ?? ''}:${historyOnly ? 'history' : 'current'}`
          if (!accounts.has(key)) {
            const allowed = historyOnly
              ? target.observerChannelId === null && (await this.repository.listAccounts(input.userId, 'history')).some(account => account.id === target.accountId)
              : await this.authorizeAccount(input.userId, target.accountId, target.observerChannelId)
            if (!allowed) {
              input.sink.close(4403, 'trading_account_forbidden')
              return null
            }
            accounts.add(key)
          }
        }
      }
      const revisions: Record<string, number> = {}
      if (observer && Object.values(target.afterRevision).some(after => after !== null && after !== undefined)) {
        input.sink.send({
          v: 4, type: 'subscription.resync_required', request_id: input.requestId ?? 'subscribe',
          targets: [target.publicTarget], reason: 'revision_unknown',
        })
        return null
      }
      for (const resource of target.resources) {
        const after = target.afterRevision[resource]
        if (observer) {
          revisions[resource] = 0
          continue
        }
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
      authorized.push({
        ...target,
        revisions,
        ...(observerAuthorization ? { observerAuthorization } : {}),
      })
    }
    const subscription: Subscription = {
      userId: input.userId,
      requestId: input.requestId ?? 'subscribe',
      targets: authorized,
      sink: input.sink,
      sequence: 0,
      closed: false,
      observerTimer: null,
      observerQueue: new Map(),
      observerDraining: false,
    }
    const observerTargets = authorized.filter(target => target.observerAuthorization)
    if (observerTargets.length > 0) {
      // The authorization may have expired while a slow initial read was in flight.
      if (observerTargets.some(target => !validObserverAuthorization(
        target.observerAuthorization!, input.userId, target.observerChannelId!, target.accountId!, this.currentTime(),
      ))) {
        input.sink.close(4403, 'trading_account_forbidden')
        return null
      }
      this.armObserverDeadline(subscription)
    }
    this.subscriptions.add(subscription)
    try {
      input.sink.send({
        v: 4,
        type: 'subscription.ready',
        request_id: subscription.requestId,
        subscriptions: authorized.flatMap((target, targetIndex) => target.resources.map((resource, resourceIndex) => ({
          subscription_id: `${targetIndex + 1}:${resourceIndex + 1}:${resource}`,
          target: { ...target.publicTarget, after_revision: target.observerAuthorization || DOMAIN_RESOURCES.has(resource) ? null : String(target.revisions[resource] ?? 0) },
          revision: String(target.revisions[resource] ?? 0),
        }))),
      })
    } catch {
      this.closeSubscription(subscription)
      throw new Error('browser_realtime_sink_failed')
    }
    return () => this.closeSubscription(subscription)
  }

  publish(event: BrowserRealtimeEvent) {
    for (const subscription of this.subscriptions) {
      if (subscription.closed) continue
      let ownerDelivered = false
      const observerDelivered = new Set<string>()
      for (const target of subscription.targets) {
        if (!targetMatches(target, subscription.userId, event)) continue
        if (target.observerAuthorization) {
          const key = `${target.observerAuthorization.channelId}:${target.observerAuthorization.accountId}:${event.resource}:${event.resourceId}`
          if (observerDelivered.has(key)) continue
          observerDelivered.add(key)
          this.enqueueObserver(subscription, target, event)
          continue
        }
        if (ownerDelivered) continue
        ownerDelivered = true
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
  }

  private enqueueObserver(subscription: Subscription, target: AuthorizedTarget, event: BrowserRealtimeEvent) {
    const resource = observerResourceForEvent(event)
    if (!resource || !target.resources.includes(`${resource}:${event.resourceId}`) && !target.resources.includes(resource)) return
    // Store only source metadata. Raw source data is deliberately never retained for async delivery.
    subscription.observerQueue.set(target, {
      target,
      event: {
        eventId: event.eventId, occurredAt: event.occurredAt, accountId: event.accountId!,
        resource, resourceId: event.resourceId, revision: event.revision, userId: event.userId,
      },
    })
    if (!subscription.observerDraining) {
      subscription.observerDraining = true
      void this.drainObserverQueue(subscription)
    }
  }

  private async drainObserverQueue(subscription: Subscription) {
    try {
      while (!subscription.closed && subscription.observerQueue.size > 0) {
        const pending = subscription.observerQueue.values().next().value as ObserverPendingPublication | undefined
        if (!pending) break
        subscription.observerQueue.delete(pending.target)
        await this.deliverObserverPublication(subscription, pending)
      }
    } catch {
      this.invalidateObserver(subscription)
    } finally {
      subscription.observerDraining = false
      if (!subscription.closed && subscription.observerQueue.size > 0) {
        subscription.observerDraining = true
        void this.drainObserverQueue(subscription)
      }
    }
  }

  private async deliverObserverPublication(subscription: Subscription, pending: ObserverPendingPublication) {
    if (subscription.closed || !this.observers) return
    const initial = pending.target.observerAuthorization
    if (!initial) return this.invalidateObserver(subscription)
    if (!validObserverAuthorization(initial, subscription.userId, initial.channelId, initial.accountId, this.currentTime())) {
      return this.invalidateObserver(subscription)
    }
    let current: ObserverAuthorization | null = null
    try {
      current = await this.observers.authorize(subscription.userId, initial.channelId, initial.accountId)
    } catch {
      return this.invalidateObserver(subscription)
    }
    if (subscription.closed) return
    if (!validObserverAuthorization(initial, subscription.userId, initial.channelId, initial.accountId, this.currentTime())) {
      return this.invalidateObserver(subscription)
    }
    if (!current || !validObserverAuthorization(current, subscription.userId, initial.channelId, initial.accountId, this.currentTime())
      || !sameObserverAuthorization(initial, current)) return this.invalidateObserver(subscription)
    for (const target of subscription.targets) {
      if (target.observerAuthorization && sameObserverAuthorization(target.observerAuthorization, initial)) {
        target.observerAuthorization = current
      }
    }
    this.armObserverDeadline(subscription)
    if (pending.event.accountId !== current.accountId || pending.event.userId !== current.operatorUserId) return
    if (subscription.closed) return
    subscription.sequence += 1
    try {
      subscription.sink.send({
        v: 4,
        event_id: observerPublicationEventId(pending.event.eventId, current.channelId),
        type: 'observer.publication.changed',
        occurred_at: pending.event.occurredAt,
        sequence: subscription.sequence,
        scope: {
          user_id: String(subscription.userId),
          trading_account_id: current.accountId,
          terminal_instance_id: null,
          observer_channel_id: current.channelId,
        },
        resource: { kind: 'observer_publication', id: current.channelId },
        revision: String(pending.event.revision),
        data: {
          channel_id: current.channelId,
          source_revision: current.sourceRevision,
          resource: pending.event.resource,
          resource_id: pending.event.resourceId,
        },
        correlation_id: null,
      })
    } catch {
      this.invalidateObserver(subscription)
    }
  }

  private invalidateObserver(subscription: Subscription) {
    if (subscription.closed) return
    subscription.closed = true
    subscription.observerQueue.clear()
    if (subscription.observerTimer !== null) clearTimeout(subscription.observerTimer)
    subscription.observerTimer = null
    this.subscriptions.delete(subscription)
    try {
      subscription.sink.send({
        v: 4, type: 'subscription.resync_required', request_id: subscription.requestId,
        targets: subscription.targets.filter(target => target.observerAuthorization).map(target => target.publicTarget),
        reason: 'authorization_changed',
      })
    } catch {
      // A socket can disappear while authorization is being rechecked; cleanup is still required.
    }
    try { subscription.sink.close(4403, 'authorization_changed') } catch { /* already closed */ }
  }

  private closeSubscription(subscription: Subscription) {
    if (subscription.closed) return
    subscription.closed = true
    subscription.observerQueue.clear()
    if (subscription.observerTimer !== null) clearTimeout(subscription.observerTimer)
    subscription.observerTimer = null
    this.subscriptions.delete(subscription)
  }

  private armObserverDeadline(subscription: Subscription) {
    if (subscription.closed) return
    const expiries = subscription.targets
      .map(target => target.observerAuthorization ? Date.parse(target.observerAuthorization.expiresAtUtc) : Infinity)
      .filter(value => Number.isFinite(value))
    if (expiries.length === 0) return
    const delay = Math.min(OBSERVER_AUTHORIZATION_TTL_MS, Math.max(0, Math.min(...expiries) - this.currentTime()))
    if (subscription.observerTimer !== null) clearTimeout(subscription.observerTimer)
    subscription.observerTimer = setTimeout(() => this.invalidateObserver(subscription), delay)
    subscription.observerTimer.unref?.()
  }

  private currentTime() {
    const value = this.now()
    return Number.isFinite(value) ? value : Date.now()
  }

  private async authorizeAccount(userId: number, accountId: string, observerChannelId: string | null) {
    if (observerChannelId) return false
    const account = await this.repository.findOwnedAccount(userId, accountId)
    return Boolean(account)
  }
}

function isHistoryOnly(target: BrowserRealtimeTarget) {
  return target.observerChannelId === null && target.resources.length > 0 && target.resources.every(resource => resource === 'trade_history')
}

function isObserverTarget(target: BrowserRealtimeTarget) {
  if (target.observerChannelId === null || target.accountId === null || target.resources.length === 0) return false
  return target.resources.every(resource => {
    const [kind, ...parts] = resource.split(':')
    if (!OBSERVER_RESOURCES.has(kind as ObserverPublicationResource)) return false
    if (kind === 'account.metrics') return parts.length === 1 && parts[0] === 'current'
    if (kind === 'positions' || kind === 'pending_orders') return parts.length === 1 && parts[0] === 'open'
    if (kind === 'market.quote') return parts.length === 1 && parts[0]!.length > 0
    return kind === 'market.candle' && parts.length === 2 && parts.every(part => part!.length > 0)
  })
}

function validObserverAuthorization(value: ObserverAuthorization, userId: number, channelId: string, accountId: string, now: number) {
  if (typeof value !== 'object' || value === null) return false
  return Number.isSafeInteger(value.userId) && value.userId === userId
    && bounded(value.channelId, 1, 191) && value.channelId === channelId
    && bounded(value.sourceId, 1, 191)
    && bounded(value.sourceRevision, 1, 128) && bounded(value.ownershipRevision, 1, 128)
    && bounded(value.channelRevision, 1, 128) && bounded(value.accessRevision, 1, 128)
    && Number.isSafeInteger(value.userTokenVersion) && value.userTokenVersion >= 0
    && bounded(value.accountId, 1, 191) && value.accountId === accountId
    && Number.isSafeInteger(value.operatorUserId) && value.operatorUserId > 0
    && bounded(value.displayName, 1, 191)
    && Number.isFinite(Date.parse(value.expiresAtUtc)) && Date.parse(value.expiresAtUtc) > now
}

function bounded(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function observerResourceForEvent(event: BrowserRealtimeEvent): ObserverPublicationResource | null {
  const resource = OBSERVER_EVENT_RESOURCES.get(event.type)
  return resource && event.resource === resource && bounded(event.resourceId, 1, 191) ? resource : null
}

function observerPublicationEventId(sourceEventId: string, channelId: string) {
  return createHash('sha256').update(`${sourceEventId}\u0000${channelId}`).digest('hex')
}

function targetMatches(target: AuthorizedTarget, userId: number, event: BrowserRealtimeEvent) {
  const key = `${event.resource}:${event.resourceId}`
  if (!target.resources.includes(key) && !target.resources.includes(event.resource)) return false
  if (target.observerAuthorization) {
    return observerResourceForEvent(event) !== null && event.accountId === target.accountId
  }
  if (PLATFORM_RESOURCES.has(event.resource)) return event.userId === null && target.accountId === null && target.observerChannelId === null
  if (event.accountId === null) return target.accountId === null && target.observerChannelId === null && event.userId === userId
  if (target.accountId !== event.accountId) return false
  return target.observerChannelId === null && event.userId === userId
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
