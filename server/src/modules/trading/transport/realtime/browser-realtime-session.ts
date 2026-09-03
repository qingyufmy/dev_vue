import type { BrowserRealtimeSink } from './browser-realtime-hub.js'
import { BrowserRealtimeHub } from './browser-realtime-hub.js'

interface Target {
  kind: 'runtime' | 'account' | 'market'
  trading_account_id: string | null
  observer_channel_id: string | null
  symbol: string | null
  timeframe: string | null
  resource_id: string | null
  after_revision: string | null
}

export class BrowserRealtimeSession {
  private stops: Array<() => void> = []
  constructor(private readonly userId: number, private readonly hub: BrowserRealtimeHub, private readonly sink: BrowserRealtimeSink) {}

  async receive(raw: unknown) {
    if (!isSubscribe(raw)) return this.protocolError('realtime_message_invalid')
    this.closeSubscriptions()
    const grouped = new Map<string, { accountId: string; observerChannelId: string | null; resources: string[]; afterRevision: Record<string, number | null> }>()
    for (const target of raw.targets) {
      if (!target.trading_account_id) return this.protocolError('realtime_scope_invalid')
      const resource = resourceFor(target)
      if (!resource) return this.protocolError('realtime_target_invalid')
      const groupKey = `${target.trading_account_id}:${target.observer_channel_id ?? ''}`
      const group = grouped.get(groupKey) ?? { accountId: target.trading_account_id, observerChannelId: target.observer_channel_id, resources: [], afterRevision: {} }
      group.resources.push(resource); group.afterRevision[resource] = target.after_revision === null ? null : Number(target.after_revision)
      grouped.set(groupKey, group)
    }
    if (grouped.size !== 1) return this.protocolError('realtime_scope_invalid')
    for (const group of grouped.values()) {
      const stop = await this.hub.subscribe({ userId: this.userId, accountId: group.accountId, observerChannelId: group.observerChannelId, requestId: raw.request_id, resources: group.resources, afterRevision: group.afterRevision, sink: this.sink })
      if (!stop) { this.closeSubscriptions(); return }
      this.stops.push(stop)
    }
  }

  closeSubscriptions() { for (const stop of this.stops.splice(0)) stop() }
  private protocolError(code: string) { this.sink.send({ v: 4, type: 'protocol.error', request_id: null, code, message: code, retryable: false }) }
}

function isSubscribe(raw: unknown): raw is { v: 4; type: 'subscription.subscribe'; request_id: string; targets: Target[] } {
  if (typeof raw !== 'object' || raw === null) return false
  const value = raw as Record<string, unknown>
  return value.v === 4 && value.type === 'subscription.subscribe' && typeof value.request_id === 'string' && value.request_id.length > 0 && value.request_id.length <= 128
    && Array.isArray(value.targets) && value.targets.length > 0 && value.targets.length <= 32
    && value.targets.every((target) => {
      if (typeof target !== 'object' || target === null) return false
      const item = target as Record<string, unknown>
      return ['runtime', 'account', 'market'].includes(String(item.kind))
        && (typeof item.trading_account_id === 'string' || item.trading_account_id === null)
        && (typeof item.observer_channel_id === 'string' || item.observer_channel_id === null)
        && (typeof item.symbol === 'string' || item.symbol === null)
        && (typeof item.timeframe === 'string' || item.timeframe === null)
        && (typeof item.resource_id === 'string' || item.resource_id === null)
        && (item.after_revision === null || (typeof item.after_revision === 'string' && /^\d+$/.test(item.after_revision)))
    })
}

function resourceFor(target: Target) {
  if (target.kind === 'runtime' && target.resource_id === 'bridge') return 'runtime.bridge:current'
  if (target.kind === 'account' && target.resource_id === 'metrics') return 'account.metrics:current'
  if (target.kind === 'account' && target.resource_id === 'positions') return 'positions:open'
  if (target.kind === 'account' && target.resource_id === 'pending_orders') return 'pending_orders:open'
  if (target.kind === 'market' && target.resource_id === 'quote' && target.symbol) return `market.quote:${target.symbol}`
  if (target.kind === 'market' && target.resource_id === 'candle' && target.symbol && target.timeframe) return `market.candle:${target.symbol}:${target.timeframe}`
  return null
}
