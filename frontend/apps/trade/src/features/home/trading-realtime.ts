import { applyRealtimeState } from '~/features/trading-context'
import { applyAccountSnapshot } from '~/features/trading-context'
import type { TradeSessionSnapshot } from '~/features/auth'
import { applyAccountMetrics } from '~/lib/apply-account-metrics'
import { createApiClient } from '@aurum/api-client'
import { browserRealtimeEventSchema, marketCandleSchema, marketQuoteSchema, openPositionSchema, pendingOrderSchema } from '@aurum/contracts'
import type { Timeframe } from '@aurum/contracts'
import { connectRealtime } from '@aurum/realtime'
import { accountSnapshot, marketCandles, marketQuote, openPositions, pendingOrders, resourceRevisions } from './home-runtime'

const client = createApiClient()
let connection: ReturnType<typeof connectRealtime> | null = null
let reconnectTimer: number | null = null
let generation = 0
let reconnectAttempt = 0
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export function stopTradingRealtime() {
  generation += 1
  if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
  reconnectTimer = null
  connection?.close(1000, 'account_changed')
  connection = null
  reconnectAttempt = 0
  applyRealtimeState('idle')
}

export async function startTradingRealtime(session: TradeSessionSnapshot, accountId: string, symbol: string, timeframe: Timeframe, observerChannelId: string | null, resync: () => Promise<void>, onAnalysisChanged?: () => void) {
  stopTradingRealtime()
  const currentGeneration = generation
  await connect(session, accountId, symbol, timeframe, observerChannelId, resync, currentGeneration, onAnalysisChanged)
}

async function connect(session: TradeSessionSnapshot, accountId: string, symbol: string, timeframe: Timeframe, observerChannelId: string | null, resync: () => Promise<void>, currentGeneration: number, onAnalysisChanged?: () => void) {
  let lastSequence = 0
  let connectionAlive = true
  let resyncInFlight = false
  let resyncQueued = false
  const requestObserverResync = async () => {
    if (currentGeneration !== generation || !connectionAlive) return
    if (resyncInFlight) { resyncQueued = true; return }
    resyncInFlight = true
    applyRealtimeState('recovering')
    try {
      do {
        resyncQueued = false
        await resync()
      } while (resyncQueued && currentGeneration === generation && connectionAlive)
      if (currentGeneration === generation && connectionAlive) applyRealtimeState('live')
    } catch {
      if (currentGeneration === generation && connectionAlive) applyRealtimeState('recovering')
    } finally {
      resyncInFlight = false
    }
  }
  applyRealtimeState('connecting')
  try { await client.createRealtimeTicket(session.csrf_token) }
  catch { scheduleReconnect(session, accountId, symbol, timeframe, observerChannelId, resync, currentGeneration, onAnalysisChanged); return }
  if (currentGeneration !== generation) return
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  try { connection = connectRealtime({
    url: `${scheme}//${location.host}/realtime/v4`, protocol: 'aurum.realtime.v4',
    onOpen(ws) {
      if (currentGeneration !== generation || !connectionAlive) return ws.close()
      const accountTargets = observerChannelId === null ? [
        { kind: 'runtime', trading_account_id: accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'bridge', after_revision: null },
        { kind: 'account', trading_account_id: accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'metrics', after_revision: String(resourceRevisions.value.account) },
        { kind: 'account', trading_account_id: accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'positions', after_revision: String(resourceRevisions.value.positions) },
        { kind: 'account', trading_account_id: accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'pending_orders', after_revision: String(resourceRevisions.value.pendingOrders) },
        { kind: 'market', trading_account_id: accountId, observer_channel_id: null, symbol, timeframe: null, resource_id: 'quote', after_revision: String(resourceRevisions.value.quote) },
        { kind: 'market', trading_account_id: accountId, observer_channel_id: null, symbol, timeframe, resource_id: 'candle', after_revision: String(resourceRevisions.value.candle) },
      ] : [
        { kind: 'account', trading_account_id: accountId, observer_channel_id: observerChannelId, symbol: null, timeframe: null, resource_id: 'metrics', after_revision: null },
        { kind: 'account', trading_account_id: accountId, observer_channel_id: observerChannelId, symbol: null, timeframe: null, resource_id: 'positions', after_revision: null },
        { kind: 'account', trading_account_id: accountId, observer_channel_id: observerChannelId, symbol: null, timeframe: null, resource_id: 'pending_orders', after_revision: null },
        { kind: 'market', trading_account_id: accountId, observer_channel_id: observerChannelId, symbol, timeframe: null, resource_id: 'quote', after_revision: null },
        { kind: 'market', trading_account_id: accountId, observer_channel_id: observerChannelId, symbol, timeframe, resource_id: 'candle', after_revision: null },
      ]
      ws.send(JSON.stringify({
      v: 4, type: 'subscription.subscribe', request_id: crypto.randomUUID(),
      targets: [
        ...accountTargets,
        { kind: 'signals', trading_account_id: null, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'market_analyses', after_revision: null },
      ],
      }))
    },
    async onMessage(raw) {
    if (currentGeneration !== generation || !connectionAlive) return
    const messageType = typeof raw === 'object' && raw !== null && 'type' in raw ? String(raw.type) : ''
    if (messageType === 'subscription.ready') { reconnectAttempt = 0; applyRealtimeState('live'); return }
    if (messageType === 'subscription.resync_required') { applyRealtimeState('recovering'); connection?.close(4000, 'revision_resync_required'); return }
    const parsed = browserRealtimeEventSchema.safeParse(raw)
    if (!parsed.success || parsed.data.scope.user_id !== session.user.id) return
    const event = parsed.data
    if (lastSequence > 0 && event.sequence !== lastSequence + 1) { applyRealtimeState('recovering'); connection?.close(4000, 'sequence_gap'); return }
    lastSequence = event.sequence
    if (event.type === 'market_analysis.created' && event.scope.trading_account_id === null) {
      onAnalysisChanged?.()
      return
    }
    if (event.type === 'observer.publication.changed') {
      if (observerChannelId === null || event.scope.trading_account_id !== accountId
        || event.scope.terminal_instance_id !== null || event.scope.observer_channel_id !== observerChannelId
        || event.resource.kind !== 'observer_publication' || event.resource.id !== observerChannelId
        || event.data.channel_id !== observerChannelId) return
      void requestObserverResync()
      return
    }
    if (observerChannelId !== null) return
    if (event.scope.trading_account_id !== accountId || event.scope.observer_channel_id !== observerChannelId) return
    if (event.type === 'runtime.bridge.changed') {
      if (accountSnapshot.value && isBridgeRuntime(event.data)) applyAccountSnapshot({
        ...accountSnapshot.value, bridgeState: event.data.state, lastSeenAt: event.data.last_seen_at,
      })
    } else if (event.type === 'market.quote.updated') {
      const data = marketQuoteSchema.safeParse({ ...objectData(event.data), account_id: accountId, trade_mode: marketQuote.value?.tradeMode ?? 'unknown', revision: event.revision }); if (data.success && data.data.symbol === symbol) { marketQuote.value = data.data; resourceRevisions.value.quote = data.data.revision }
    } else if (event.type === 'market.candle.updated' || event.type === 'market.candle.closed') {
      const data = marketCandleSchema.safeParse({ ...objectData(event.data), account_id: accountId, revision: event.revision })
      if (data.success && data.data.symbol === symbol && data.data.timeframe === timeframe) { upsertCandle(data.data); resourceRevisions.value.candle = data.data.revision }
    } else if (event.type === 'positions.changed') {
      const data = openPositionSchema.array().safeParse(collectionItems(event.data)); if (data.success) { openPositions.value = data.data; resourceRevisions.value.positions = Number(event.revision) }
    } else if (event.type === 'pending_orders.changed') {
      const data = pendingOrderSchema.array().safeParse(collectionItems(event.data)); if (data.success) { pendingOrders.value = data.data; resourceRevisions.value.pendingOrders = Number(event.revision) }
    } else if (event.type === 'account.metrics.changed') {
      if (accountSnapshot.value && accountSnapshot.value.id === accountId) {
        applyAccountSnapshot(applyAccountMetrics(accountSnapshot.value, event.data, Number(event.revision)))
        resourceRevisions.value.account = accountSnapshot.value.revision
      }
    }
    },
    onError() { if (currentGeneration === generation && connectionAlive) applyRealtimeState('recovering') },
    onClose() {
    connectionAlive = false
    if (currentGeneration !== generation) return
    connection = null
    scheduleReconnect(session, accountId, symbol, timeframe, observerChannelId, resync, currentGeneration, onAnalysisChanged)
    },
  }) } catch { scheduleReconnect(session, accountId, symbol, timeframe, observerChannelId, resync, currentGeneration, onAnalysisChanged) }
}

function scheduleReconnect(session: TradeSessionSnapshot, accountId: string, symbol: string, timeframe: Timeframe, observerChannelId: string | null, resync: () => Promise<void>, currentGeneration: number, onAnalysisChanged?: () => void) {
  if (currentGeneration !== generation || reconnectTimer !== null) return
  applyRealtimeState('offline')
  const baseDelay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000
  reconnectAttempt += 1
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (currentGeneration !== generation) return
    void resync().then(
      () => {
        if (currentGeneration === generation) return connect(session, accountId, symbol, timeframe, observerChannelId, resync, currentGeneration, onAnalysisChanged)
      },
      () => scheduleReconnect(session, accountId, symbol, timeframe, observerChannelId, resync, currentGeneration, onAnalysisChanged),
    )
  }, delay)
}

function collectionItems(value: unknown) {
  return typeof value === 'object' && value !== null && 'items' in value ? value.items : null
}
function objectData(value: unknown) { return typeof value === 'object' && value !== null ? value : {} }

function isBridgeRuntime(value: unknown): value is { state: 'online' | 'offline' | 'paused' | 'replaced' | 'unauthorized'; last_seen_at: string } {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Record<string, unknown>
  return ['online', 'offline', 'paused', 'replaced', 'unauthorized'].includes(String(data.state)) && typeof data.last_seen_at === 'string'
}

function upsertCandle(candle: typeof marketCandles.value[number]) {
  const items = marketCandles.value
  const last = items.at(-1)
  if (last?.openTime === candle.openTime) marketCandles.value = [...items.slice(0, -1), candle]
  else if (!last || last.openTime < candle.openTime) marketCandles.value = [...items, candle].slice(-500)
}
