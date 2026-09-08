import type { BrowserRealtimeTarget } from './browser-realtime-hub.js'
import type { BrowserRealtimeSink, BrowserRealtimeConnection } from '../../application/browser-realtime-ports.js'
import { BrowserRealtimeHub } from './browser-realtime-hub.js'

interface Target {
  kind: 'runtime' | 'account' | 'market' | 'signals' | 'risk' | 'reviews' | 'trades' | 'operations' | 'audit'
  trading_account_id?: string | null
  observer_channel_id?: string | null
  symbol?: string | null
  timeframe?: string | null
  resource_id?: string | null
  after_revision: string | null
}

export class BrowserRealtimeSession implements BrowserRealtimeConnection {
  private stops: Array<() => void> = []
  private closed = false
  private generation = 0
  private readonly sink: BrowserRealtimeSink
  constructor(private readonly userId: number, private readonly hub: BrowserRealtimeHub, sink: BrowserRealtimeSink) {
    this.sink = {
      send: message => { if (!this.closed) sink.send(message) },
      close: (code, reason) => { if (!this.closed) { this.close(); sink.close(code, reason) } },
    }
  }

  async receive(raw: unknown) {
    if (this.closed) return
    if (isPing(raw)) {
      this.sink.send({ v: 4, type: 'system.pong', request_id: raw.request_id, occurred_at: new Date().toISOString() })
      return
    }
    if (isUnsubscribe(raw)) {
      this.closeSubscriptions()
      this.sink.send({ v: 4, type: 'subscription.unsubscribed', request_id: raw.request_id })
      return
    }
    if (!isSubscribe(raw)) return this.protocolError('realtime_message_invalid')
    const targets: BrowserRealtimeTarget[] = []
    for (const rawTarget of raw.targets) {
      const target = normalizeTarget(rawTarget)
      const resources = resourcesFor(target)
      if (!resources || !validScope(target)) return this.protocolError('realtime_target_invalid')
      const after = target.after_revision === null ? null : Number(target.after_revision)
      targets.push({
        accountId: target.trading_account_id,
        observerChannelId: target.observer_channel_id,
        resources,
        afterRevision: Object.fromEntries(resources.map(resource => [resource, after])),
        publicTarget: target as unknown as Record<string, unknown>,
      })
    }
    const generation = this.generation
    const sink: BrowserRealtimeSink = {
      send: message => { if (generation === this.generation) this.sink.send(message) },
      close: (code, reason) => { if (generation === this.generation) this.sink.close(code, reason) },
    }
    const stop = await this.hub.subscribeTargets({ userId: this.userId, requestId: raw.request_id, targets, sink })
    if (!stop) return
    if (this.closed || generation !== this.generation) { stop(); return }
    const previous = this.stops.splice(0)
    this.stops.push(stop)
    for (const release of previous) release()
  }

  close() { this.closed = true; this.closeSubscriptions() }
  closeSubscriptions() { this.generation += 1; for (const stop of this.stops.splice(0)) stop() }
  private protocolError(code: string) { this.sink.send({ v: 4, type: 'protocol.error', request_id: null, code, message: code, retryable: false }) }
}

function isPing(raw: unknown): raw is { v: 4; type: 'system.ping'; request_id: string } {
  if (typeof raw !== 'object' || raw === null) return false
  const value = raw as Record<string, unknown>
  return value.v === 4 && value.type === 'system.ping' && validRequestId(value.request_id)
    && Object.keys(value).every(key => ['v', 'type', 'request_id'].includes(key))
}

function isUnsubscribe(raw: unknown): raw is { v: 4; type: 'subscription.unsubscribe'; request_id: string } {
  if (typeof raw !== 'object' || raw === null) return false
  const value = raw as Record<string, unknown>
  return value.v === 4 && value.type === 'subscription.unsubscribe' && validRequestId(value.request_id)
    && Object.keys(value).every(key => ['v', 'type', 'request_id'].includes(key))
}

function isSubscribe(raw: unknown): raw is { v: 4; type: 'subscription.subscribe'; request_id: string; targets: Target[] } {
  if (typeof raw !== 'object' || raw === null) return false
  const value = raw as Record<string, unknown>
  return value.v === 4 && value.type === 'subscription.subscribe' && validRequestId(value.request_id)
    && Array.isArray(value.targets) && value.targets.length > 0 && value.targets.length <= 32
    && value.targets.every((target) => {
      if (typeof target !== 'object' || target === null) return false
      const item = target as Record<string, unknown>
      return Object.keys(item).every(key => ['kind', 'trading_account_id', 'observer_channel_id', 'symbol', 'timeframe', 'resource_id', 'after_revision'].includes(key))
        && ['runtime', 'account', 'market', 'signals', 'risk', 'reviews', 'trades', 'operations', 'audit'].includes(String(item.kind))
        && (item.trading_account_id === undefined || typeof item.trading_account_id === 'string' || item.trading_account_id === null)
        && (item.observer_channel_id === undefined || typeof item.observer_channel_id === 'string' || item.observer_channel_id === null)
        && (item.symbol === undefined || typeof item.symbol === 'string' || item.symbol === null)
        && (item.timeframe === undefined || typeof item.timeframe === 'string' || item.timeframe === null)
        && (item.resource_id === undefined || typeof item.resource_id === 'string' || item.resource_id === null)
        && (item.after_revision === null || (typeof item.after_revision === 'string' && /^\d+$/.test(item.after_revision)))
    })
}

function normalizeTarget(target: Target): Required<Target> {
  return {
    kind: target.kind,
    trading_account_id: target.trading_account_id ?? null,
    observer_channel_id: target.observer_channel_id ?? null,
    symbol: target.symbol ?? null,
    timeframe: target.timeframe ?? null,
    resource_id: target.resource_id ?? null,
    after_revision: target.after_revision,
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function validScope(target: Required<Target>) {
  if (target.kind === 'market' && ['macro', 'calendar'].includes(target.resource_id ?? '')) {
    return target.trading_account_id === null && target.observer_channel_id === null
      && target.symbol === null && target.timeframe === null && target.after_revision === null
  }
  if (target.kind === 'signals') {
    const userScoped = target.resource_id === null || ['all', 'analysis_jobs', 'market_analyses'].includes(target.resource_id)
    return userScoped
      ? target.trading_account_id === null && target.observer_channel_id === null
      : Boolean(target.trading_account_id) && target.observer_channel_id === null
        && ['trader_jobs', 'trade_decisions'].includes(target.resource_id ?? '')
  }
  if (target.kind === 'risk') {
    return Boolean(target.trading_account_id) && target.observer_channel_id === null
  }
  if (target.kind === 'reviews') return target.trading_account_id === null && target.observer_channel_id === null
  if (target.kind === 'audit') return target.trading_account_id === null && target.observer_channel_id === null
  if (target.kind === 'operations') return target.observer_channel_id === null
  return Boolean(target.trading_account_id)
}

function resourcesFor(target: Required<Target>): string[] | null {
  if (target.kind === 'runtime' && target.resource_id === 'bridge') return ['runtime.bridge:current']
  if (target.kind === 'account' && target.resource_id === 'metrics') return ['account.metrics:current']
  if (target.kind === 'account' && target.resource_id === 'positions') return ['positions:open']
  if (target.kind === 'account' && target.resource_id === 'pending_orders') return ['pending_orders:open']
  if (target.kind === 'market' && target.resource_id === 'quote' && target.symbol) return [`market.quote:${target.symbol}`]
  if (target.kind === 'market' && target.resource_id === 'candle' && target.symbol && target.timeframe) return [`market.candle:${target.symbol}:${target.timeframe}`]
  if (target.kind === 'market' && target.resource_id === 'macro') return ['macro_snapshot']
  if (target.kind === 'market' && target.resource_id === 'calendar') return ['calendar_event']
  if (target.kind === 'signals') {
    if (target.resource_id === null || target.resource_id === 'all') return ['analysis.job', 'market_analysis']
    if (target.resource_id === 'analysis_jobs') return ['analysis.job']
    if (target.resource_id === 'market_analyses') return ['market_analysis']
    if (target.resource_id === 'trader_jobs') return ['trader.job']
    if (target.resource_id === 'trade_decisions') return ['trade_decision']
  }
  if (target.kind === 'risk') {
    if (target.resource_id === null || target.resource_id === 'all') return ['risk.policy', 'risk.summary', 'risk.decision', 'risk.manual_release']
    if (target.resource_id === 'policy') return ['risk.policy']
    if (target.resource_id === 'summary') return ['risk.summary']
    if (target.resource_id === 'decisions') return ['risk.decision']
    if (target.resource_id === 'manual_release') return ['risk.manual_release']
  }
  if (target.kind === 'reviews') {
    if (target.resource_id === null || target.resource_id === 'all') return ['review_case', 'strategy_memory']
    if (target.resource_id === 'cases') return ['review_case']
    if (target.resource_id === 'memories') return ['strategy_memory']
  }
  if (target.kind === 'trades' && (target.resource_id === null || target.resource_id === 'history')) return ['trade_history']
  if (target.kind === 'operations' && (target.resource_id === null || target.resource_id === 'all')) return ['operation']
  if (target.kind === 'audit' && (target.resource_id === null || target.resource_id === 'all')) return ['audit']
  return null
}
