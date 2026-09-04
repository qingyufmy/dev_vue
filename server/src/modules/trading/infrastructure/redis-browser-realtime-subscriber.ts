import type { Redis } from 'ioredis'
import type { TradingRealtimeEvent } from '../application/trading-ports.js'
import type { BrowserRealtimeHub } from '../transport/realtime/browser-realtime-hub.js'

export const BROWSER_REALTIME_EVENT_CHANNEL = 'aurum:v4:browser-realtime:events'
const MAX_EVENT_BYTES = 64 * 1024
const EVENT_RESOURCES = new Map<TradingRealtimeEvent['type'], TradingRealtimeEvent['resource']>([
  ['runtime.bridge.changed', 'runtime.bridge'],
  ['account.metrics.changed', 'account.metrics'],
  ['market.quote.updated', 'market.quote'],
  ['market.candle.updated', 'market.candle'],
  ['market.candle.closed', 'market.candle'],
  ['positions.changed', 'positions'],
  ['pending_orders.changed', 'pending_orders'],
])

export class RedisBrowserRealtimeSubscriber {
  private started = false
  private readonly onMessage = (channel: string, raw: string) => {
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
    private readonly hub: Pick<BrowserRealtimeHub, 'publish'>,
    private readonly channel = BROWSER_REALTIME_EVENT_CHANNEL,
    private readonly onInvalidEvent: (code: string) => void = () => undefined,
  ) {}

  async start() {
    if (this.started) return
    this.redis.on('message', this.onMessage)
    try {
      await this.redis.subscribe(this.channel)
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
    await this.redis.unsubscribe(this.channel)
  }
}

export function parseBrowserRealtimeEvent(raw: string): TradingRealtimeEvent | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_EVENT_BYTES) return null
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { return null }
  if (!record(value)) return null
  const type = typeof value.type === 'string' ? value.type as TradingRealtimeEvent['type'] : null
  const resource = typeof value.resource === 'string' ? value.resource as TradingRealtimeEvent['resource'] : null
  if (!type || !resource || EVENT_RESOURCES.get(type) !== resource) return null
  if (!bounded(value.eventId, 1, 191) || !isoUtc(value.occurredAt)
    || !Number.isSafeInteger(value.userId) || Number(value.userId) <= 0
    || !bounded(value.accountId, 1, 191)
    || !(value.terminalInstanceId === null || bounded(value.terminalInstanceId, 1, 191))
    || !bounded(value.resourceId, 1, 191)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !Object.hasOwn(value, 'data')) return null
  return {
    eventId: value.eventId,
    type,
    occurredAt: value.occurredAt,
    userId: Number(value.userId),
    accountId: value.accountId,
    terminalInstanceId: value.terminalInstanceId,
    resource,
    resourceId: value.resourceId,
    revision: Number(value.revision),
    data: value.data,
  }
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
