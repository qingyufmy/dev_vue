import { createApiClient } from '@aurum/api-client'
import { browserRealtimeEventSchema } from '@aurum/contracts'
import type { SessionSummary } from '@aurum/contracts'
import { connectRealtime } from '@aurum/realtime'

export type AuditRealtimeState = 'idle' | 'connecting' | 'live' | 'recovering' | 'offline'

const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

type AuditRealtimeInput = {
  session: SessionSummary
  onState: (state: AuditRealtimeState) => void
  onChanged: () => void
  resync: () => Promise<unknown>
}

type RealtimeRecord = Record<string, unknown>

export function createAuditRealtime(input: AuditRealtimeInput) {
  const client = createApiClient()
  let stopped = false
  let attempt = 0
  let timer: number | null = null
  let connection: ReturnType<typeof connectRealtime> | null = null
  let lastSequence = 0

  const stop = () => {
    stopped = true
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    connection?.close(1000, 'audit_page_left')
    connection = null
    input.onState('idle')
  }

  const schedule = () => {
    if (stopped || timer !== null) return
    input.onState('offline')
    const base = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 30_000
    attempt += 1
    const jitter = 0.8 + Math.random() * 0.4
    timer = window.setTimeout(() => {
      timer = null
      if (stopped) return
      input.onState('recovering')
      void input.resync().catch(() => undefined).finally(() => void connect())
    }, Math.round(base * jitter))
  }

  const connect = async () => {
    if (stopped) return
    input.onState('connecting')
    try {
      await client.createRealtimeTicket(input.session.csrf_token)
    } catch {
      schedule()
      return
    }
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
            targets: [{
              kind: 'audit',
              trading_account_id: null,
              observer_channel_id: null,
              symbol: null,
              timeframe: null,
              resource_id: 'all',
              after_revision: null,
            }],
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
            connection?.close(4000, 'audit_resync_required')
            return
          }
          const parsed = browserRealtimeEventSchema.safeParse(raw)
          if (!parsed.success || !isAuditChanged(parsed.data)) return
          const scope = record(parsed.data.scope)
          const sequence = parsed.data.sequence
          if (!scope || typeof scope.user_id !== 'string' || scope.user_id !== input.session.user.id) return
          if (scope.observer_channel_id !== null) return
          if (scope.trading_account_id !== null) return
          if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) return
          if (lastSequence > 0 && sequence !== lastSequence + 1) {
            input.onState('recovering')
            connection?.close(4000, 'audit_sequence_gap')
            return
          }
          lastSequence = sequence
          input.onChanged()
        },
        onError() {
          if (!stopped) input.onState('recovering')
        },
        onClose() {
          connection = null
          schedule()
        },
      })
    } catch {
      schedule()
    }
  }

  void connect()
  return { stop }
}

function record(value: unknown): RealtimeRecord | null {
  return typeof value === 'object' && value !== null ? value as RealtimeRecord : null
}

function isAuditChanged(value: unknown): value is RealtimeRecord & {
  type: 'audit.changed'
  scope: unknown
  resource: unknown
  sequence: unknown
  revision: unknown
} {
  const item = record(value)
  return item?.type === 'audit.changed'
    && 'scope' in item
    && 'resource' in item
    && 'sequence' in item
    && 'revision' in item
}
