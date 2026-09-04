import { createApiClient } from '@aurum/api-client'
import { browserRealtimeEventSchema } from '@aurum/contracts'
import type { SessionSummary } from '@aurum/contracts'
import { connectRealtime } from '@aurum/realtime'

const client = createApiClient()
const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export type RiskRealtimeState = 'idle' | 'connecting' | 'live' | 'recovering' | 'offline'
export type RiskChangeKind = 'policy' | 'summary' | 'decision' | 'manual_release'

export function createRiskRealtime(input: {
  session: SessionSummary
  accountId: string
  onState: (state: RiskRealtimeState) => void
  onChanged: (kind: RiskChangeKind, resourceId: string) => void
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
    connection?.close(1000, 'risk_page_left')
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
    try {
      connection = connectRealtime({
        url: `${scheme}//${location.host}/realtime/v4`,
        protocol: 'aurum.realtime.v4',
        onOpen(socket) {
          socket.send(JSON.stringify({
            v: 4,
            type: 'subscription.subscribe',
            request_id: crypto.randomUUID(),
            targets: [{ kind: 'risk', trading_account_id: input.accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null }],
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
            connection?.close(4000, 'risk_resync_required')
            return
          }
          const parsed = browserRealtimeEventSchema.safeParse(raw)
          if (!parsed.success || !parsed.data.type.startsWith('risk.')) return
          const event = parsed.data
          if (event.scope.user_id !== input.session.user.id || event.scope.trading_account_id !== input.accountId || event.scope.observer_channel_id !== null) return
          if (lastSequence > 0 && event.sequence !== lastSequence + 1) {
            input.onState('recovering')
            connection?.close(4000, 'risk_sequence_gap')
            return
          }
          lastSequence = event.sequence
          const revision = numericRevision(event.revision)
          const key = `${event.resource.kind}:${event.resource.id}`
          const previous = revisions.get(key)
          if (revision !== null && previous !== undefined && revision <= previous) return
          if (revision !== null) revisions.set(key, revision)
          const kind: RiskChangeKind = event.type === 'risk.policy.changed'
            ? 'policy'
            : event.type === 'risk.summary.changed'
              ? 'summary'
              : event.type === 'risk.decision.created'
                ? 'decision'
                : 'manual_release'
          input.onChanged(kind, event.resource.id)
        },
        onError() { if (!stopped) input.onState('recovering') },
        onClose() { connection = null; schedule() },
      })
    } catch { schedule() }
  }

  void connect()
  return { stop }
}

function numericRevision(value: string) {
  try { return /^\d+$/.test(value) ? BigInt(value) : null }
  catch { return null }
}
