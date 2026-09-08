import type { Redis } from 'ioredis'
import type { BrowserRealtimeEvent, BrowserRealtimeEventType, BrowserRealtimeResource } from '../application/trading-ports.js'
import type { BrowserRealtimePublication } from '../application/browser-realtime-ports.js'
import { OBSERVER_CONTROL_CHANNEL, observerInvalidation } from '../application/observer-invalidation.js'
import { BROWSER_REALTIME_EVENT_CHANNEL } from '../application/browser-realtime-protocol.js'

const MAX_EVENT_BYTES = 64 * 1024
const EVENT_RESOURCES = new Map<BrowserRealtimeEventType, BrowserRealtimeResource>([
  ['runtime.bridge.changed', 'runtime.bridge'],
  ['account.metrics.changed', 'account.metrics'],
  ['market.quote.updated', 'market.quote'],
  ['market.candle.updated', 'market.candle'],
  ['market.candle.closed', 'market.candle'],
  ['positions.changed', 'positions'],
  ['pending_orders.changed', 'pending_orders'],
  ['analysis.job.changed', 'analysis.job'],
  ['market_analysis.created', 'market_analysis'],
  ['trader.job.changed', 'trader.job'],
  ['trade_decision.created', 'trade_decision'],
  ['risk.policy.changed', 'risk.policy'],
  ['risk.summary.changed', 'risk.summary'],
  ['risk.decision.created', 'risk.decision'],
  ['risk.manual_release.changed', 'risk.manual_release'],
  ['review.case.changed', 'review_case'],
  ['strategy.memory.changed', 'strategy_memory'],
  ['trade.history.changed', 'trade_history'],
  ['market.macro.changed', 'macro_snapshot'],
  ['market.calendar.changed', 'calendar_event'],
  ['market.source_health.changed', 'macro_source_health'],
  ['operation.changed', 'operation'],
  ['audit.changed', 'audit'],
])
const USER_SCOPED_TYPES = new Set<BrowserRealtimeEventType>([
  'analysis.job.changed', 'market_analysis.created', 'review.case.changed', 'strategy.memory.changed', 'audit.changed',
])
const PLATFORM_SCOPED_TYPES = new Set<BrowserRealtimeEventType>([
  'market.macro.changed', 'market.calendar.changed', 'market.source_health.changed',
])

export class RedisBrowserRealtimeSubscriber {
  private started = false
  private readonly onMessage = (channel: string, raw: string) => {
    if (channel === OBSERVER_CONTROL_CHANNEL) {
      let payload: unknown
      try { payload = Buffer.byteLength(raw, 'utf8') <= 1024 ? JSON.parse(raw) : null }
      catch { payload = null }
      const invalidation = observerInvalidation(payload)
      if (!invalidation) { this.onInvalidEvent('observer_invalidation_invalid'); return }
      this.hub.invalidateObserverAuthorization(invalidation)
      return
    }
    if (channel !== this.channel) return
    const event = parseBrowserRealtimeEvent(raw)
    if (!event) {
      this.onInvalidEvent('browser_realtime_event_invalid')
      return
    }
    this.hub.publish(event)
  }

  constructor(
    private readonly redis: Redis,
    private readonly hub: BrowserRealtimePublication,
    private readonly channel = BROWSER_REALTIME_EVENT_CHANNEL,
    private readonly onInvalidEvent: (code: string) => void = () => undefined,
  ) {}

  async start() {
    if (this.started) return
    this.redis.on('message', this.onMessage)
    try {
      await this.redis.subscribe(this.channel, OBSERVER_CONTROL_CHANNEL)
      this.started = true
    } catch (error) {
      this.redis.off('message', this.onMessage)
      throw error
    }
  }

  async close() {
    this.redis.off('message', this.onMessage)
    if (!this.started) return
    this.started = false
    await this.redis.unsubscribe(this.channel, OBSERVER_CONTROL_CHANNEL)
  }
}

export function parseBrowserRealtimeEvent(raw: string): BrowserRealtimeEvent | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_EVENT_BYTES) return null
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { return null }
  if (!record(value)) return null
  const type = typeof value.type === 'string' ? value.type as BrowserRealtimeEventType : null
  const resource = typeof value.resource === 'string' ? value.resource as BrowserRealtimeResource : null
  if (!type || !resource || EVENT_RESOURCES.get(type) !== resource) return null
  const platformScoped = PLATFORM_SCOPED_TYPES.has(type)
  if (!bounded(value.eventId, 1, 191) || !isoUtc(value.occurredAt)
    || (platformScoped ? value.userId !== null : (!Number.isSafeInteger(value.userId) || Number(value.userId) <= 0))
    || !(value.accountId === null || bounded(value.accountId, 1, 191))
    || !(value.terminalInstanceId === null || bounded(value.terminalInstanceId, 1, 191))
    || !bounded(value.resourceId, 1, 191)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !Object.hasOwn(value, 'data')) return null
  if (platformScoped) {
    if (value.accountId !== null || value.terminalInstanceId !== null) return null
    if (!platformDataValid(type, value.data)) return null
  } else if (USER_SCOPED_TYPES.has(type) !== (value.accountId === null)) return null
  return {
    eventId: value.eventId,
    type,
    occurredAt: value.occurredAt,
    userId: platformScoped ? null : Number(value.userId),
    accountId: value.accountId,
    terminalInstanceId: value.terminalInstanceId,
    resource,
    resourceId: value.resourceId,
    revision: Number(value.revision),
    data: value.data,
  }
}

function platformDataValid(type: BrowserRealtimeEventType, data: unknown) {
  if (!record(data)) return false
  if (type === 'market.macro.changed') {
    return exactKeys(data, ['change', 'published_at', 'status'])
      && ['created', 'updated', 'superseded', 'invalidated'].includes(String(data.change))
      && isoUtc(data.published_at)
      && ['fresh', 'stale', 'partial', 'unavailable'].includes(String(data.status))
  }
  if (type === 'market.calendar.changed') {
    return exactKeys(data, ['change', 'scheduled_at', 'importance', 'status'])
      && ['created', 'updated', 'superseded', 'invalidated'].includes(String(data.change))
      && isoUtc(data.scheduled_at)
      && ['low', 'medium', 'high', 'unknown'].includes(String(data.importance))
      && ['scheduled', 'released', 'revised', 'delayed', 'cancelled'].includes(String(data.status))
  }
  if (type === 'market.source_health.changed') {
    return exactKeys(data, ['source_id', 'health', 'observed_at'])
      && bounded(data.source_id, 1, 191)
      && bounded(data.health, 1, 64)
      && isoUtc(data.observed_at)
  }
  return false
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bounded(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function isoUtc(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
}
