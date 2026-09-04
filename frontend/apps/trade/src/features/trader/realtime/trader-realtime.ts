import { createApiClient } from '@aurum/api-client'
import { browserRealtimeEventSchema, openPositionSchema, pendingOrderSchema } from '@aurum/contracts'
import type { OpenPosition, PendingOrder, SessionSummary } from '@aurum/contracts'
import { connectRealtime } from '@aurum/realtime'

const client = createApiClient()
const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export type TraderRealtimeState = 'idle' | 'connecting' | 'live' | 'recovering' | 'offline'

export function createTraderRealtime(input: {
  session: SessionSummary
  accountId: string
  observerChannelId: string | null
  positionsRevision: number
  pendingOrdersRevision: number
  onState: (state: TraderRealtimeState) => void
  onPositions: (items: OpenPosition[], revision: number) => void
  onPendingOrders: (items: PendingOrder[], revision: number) => void
  onMetrics: (data: AccountMetricsUpdate, revision: number) => void
  onBridge: (data: BridgeRuntimeUpdate) => void
  onDecisionChanged: (decisionId: string) => void
  onOperationChanged: (operationId: string) => void
  resync: () => Promise<unknown>
}) {
  let stopped = false
  let attempt = 0
  let timer: number | null = null
  let connection: ReturnType<typeof connectRealtime> | null = null
  let lastSequence = 0
  const revisions = new Map<string, bigint>()

  const stop = () => {
    stopped = true
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    connection?.close(1000, 'trader_page_left')
    connection = null
    input.onState('idle')
  }

  const schedule = () => {
    if (stopped || timer !== null) return
    input.onState('offline')
    const base = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 30_000
    attempt += 1
    timer = window.setTimeout(() => {
      timer = null
      if (stopped) return
      input.onState('recovering')
      void input.resync().then(() => void connect(), schedule)
    }, Math.round(base * (0.8 + Math.random() * 0.4)))
  }

  const connect = async () => {
    if (stopped) return
    input.onState('connecting')
    try { await client.createRealtimeTicket(input.session.csrf_token) }
    catch { schedule(); return }
    if (stopped) return
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ownerTargets = input.observerChannelId ? [] : [
      { kind: 'signals', trading_account_id: input.accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'trade_decisions', after_revision: null },
      { kind: 'operations', trading_account_id: input.accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null },
      { kind: 'operations', trading_account_id: null, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null },
    ]
    try {
      connection = connectRealtime({
        url: `${scheme}//${location.host}/realtime/v4`,
        protocol: 'aurum.realtime.v4',
        onOpen(socket) {
          socket.send(JSON.stringify({
            v: 4,
            type: 'subscription.subscribe',
            request_id: crypto.randomUUID(),
            targets: [
              { kind: 'runtime', trading_account_id: input.accountId, observer_channel_id: input.observerChannelId, symbol: null, timeframe: null, resource_id: 'bridge', after_revision: null },
              { kind: 'account', trading_account_id: input.accountId, observer_channel_id: input.observerChannelId, symbol: null, timeframe: null, resource_id: 'metrics', after_revision: null },
              { kind: 'account', trading_account_id: input.accountId, observer_channel_id: input.observerChannelId, symbol: null, timeframe: null, resource_id: 'positions', after_revision: String(input.positionsRevision) },
              { kind: 'account', trading_account_id: input.accountId, observer_channel_id: input.observerChannelId, symbol: null, timeframe: null, resource_id: 'pending_orders', after_revision: String(input.pendingOrdersRevision) },
              ...ownerTargets,
            ],
          }))
        },
        onMessage(raw) {
          if (stopped) return
          const messageType = typeof raw === 'object' && raw !== null && 'type' in raw ? String(raw.type) : ''
          if (messageType === 'subscription.ready') {
            attempt = 0
            lastSequence = 0
            input.onState('live')
            return
          }
          if (messageType === 'subscription.resync_required') {
            input.onState('recovering')
            connection?.close(4000, 'trader_resync_required')
            return
          }
          const parsed = browserRealtimeEventSchema.safeParse(raw)
          if (!parsed.success || parsed.data.scope.user_id !== input.session.user.id) return
          const event = parsed.data
          const userOperation = event.type === 'operation.changed' && event.scope.trading_account_id === null && input.observerChannelId === null
          if (!userOperation && (event.scope.trading_account_id !== input.accountId || event.scope.observer_channel_id !== input.observerChannelId)) return
          if (lastSequence > 0 && event.sequence !== lastSequence + 1) {
            input.onState('recovering')
            connection?.close(4000, 'trader_sequence_gap')
            return
          }
          lastSequence = event.sequence
          const revision = numericRevision(event.revision)
          const key = `${event.resource.kind}:${event.resource.id}`
          const previous = revisions.get(key)
          if (revision !== null && previous !== undefined && revision <= previous) return
          if (revision !== null) revisions.set(key, revision)

          if (event.type === 'positions.changed') {
            const items = openPositionSchema.array().safeParse(collectionItems(event.data))
            if (items.success) input.onPositions(items.data, Number(event.revision))
          } else if (event.type === 'pending_orders.changed') {
            const items = pendingOrderSchema.array().safeParse(collectionItems(event.data))
            if (items.success) input.onPendingOrders(items.data, Number(event.revision))
          } else if (event.type === 'account.metrics.changed' && isMetrics(event.data)) {
            input.onMetrics(event.data, Number(event.revision))
          } else if (event.type === 'runtime.bridge.changed' && isBridgeRuntime(event.data)) {
            input.onBridge(event.data)
          } else if (event.type === 'trade_decision.created') {
            input.onDecisionChanged(event.resource.id)
          } else if (event.type === 'operation.changed') {
            input.onOperationChanged(event.resource.id)
          }
        },
        onError() { if (!stopped) input.onState('recovering') },
        onClose() { connection = null; schedule() },
      })
    } catch { schedule() }
  }

  void connect()
  return { stop }
}

function collectionItems(value: unknown) {
  return typeof value === 'object' && value !== null && 'items' in value ? value.items : null
}

function numericRevision(value: string) {
  try { return /^\d+$/.test(value) ? BigInt(value) : null }
  catch { return null }
}

interface AccountMetricsUpdate {
  balance: string
  equity: string
  margin: string
  free_margin: string
  floating_profit: string
  observed_at: string
}

interface BridgeRuntimeUpdate {
  state: 'online' | 'offline' | 'paused' | 'replaced' | 'unauthorized'
  last_seen_at: string
}

function isMetrics(value: unknown): value is AccountMetricsUpdate {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Record<string, unknown>
  return ['balance', 'equity', 'margin', 'free_margin', 'floating_profit', 'observed_at']
    .every((key) => typeof data[key] === 'string')
}

function isBridgeRuntime(value: unknown): value is BridgeRuntimeUpdate {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Record<string, unknown>
  return ['online', 'offline', 'paused', 'replaced', 'unauthorized'].includes(String(data.state))
    && typeof data.last_seen_at === 'string'
}
