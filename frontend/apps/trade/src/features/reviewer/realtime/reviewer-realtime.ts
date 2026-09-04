import { createApiClient } from '@aurum/api-client'
import { reviewRealtimeEventSchema } from '@aurum/contracts'
import type { ReviewRealtimeEvent, SessionSummary } from '@aurum/contracts'
import { connectRealtime } from '@aurum/realtime'

const client = createApiClient()
const reconnectDelays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export type ReviewerRealtimeState = 'idle' | 'connecting' | 'live' | 'recovering' | 'offline'

/**
 * Keeps the reviewer view event-driven without putting review bodies on the
 * socket. HTTP remains the source of truth; a valid event only invalidates the
 * affected list/detail, while reconnects resync before subscribing again.
 */
export function createReviewerRealtime(input: {
  session: SessionSummary
  onState: (state: ReviewerRealtimeState) => void
  onEvent: (event: ReviewRealtimeEvent) => void
  resync: () => Promise<unknown>
}) {
  let stopped = false
  let attempt = 0
  let timer: number | null = null
  let connection: ReturnType<typeof connectRealtime> | null = null
  let connecting = false
  let lastSequence = 0
  const revisions = new Map<string, bigint>()

  const stop = () => {
    stopped = true
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    connection?.close(1000, 'reviewer_page_left')
    connection = null
    connecting = false
    input.onState('idle')
  }

  const schedule = () => {
    if (stopped || timer !== null || connecting) return
    input.onState('offline')
    const base = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 30_000
    attempt += 1
    timer = window.setTimeout(() => {
      timer = null
      if (stopped) return
      input.onState('recovering')
      void input.resync().then(
        () => { if (!stopped) void connect() },
        () => schedule(),
      )
    }, Math.round(base * (0.8 + Math.random() * 0.4)))
  }

  const connect = async () => {
    if (stopped || connecting || connection) return
    connecting = true
    input.onState('connecting')
    try {
      await client.createRealtimeTicket(input.session.csrf_token)
      if (stopped) return
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      connection = connectRealtime({
        url: `${scheme}//${location.host}/realtime/v4`,
        protocol: 'aurum.realtime.v4',
        onOpen(socket) {
          socket.send(JSON.stringify({
            v: 4,
            type: 'subscription.subscribe',
            request_id: crypto.randomUUID(),
            targets: [{
              kind: 'reviews',
              resource_id: 'all',
              // Review targets are aggregate-list invalidations. They never
              // pretend that one case revision is a comparable list revision.
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
            connection?.close(4000, 'reviewer_resync_required')
            return
          }

          const parsed = reviewRealtimeEventSchema.safeParse(raw)
          if (!parsed.success) return
          const event = parsed.data
          if (event.scope.user_id !== input.session.user.id || event.scope.trading_account_id !== null || event.scope.observer_channel_id !== null) return
          if (lastSequence > 0 && event.sequence !== lastSequence + 1) {
            input.onState('recovering')
            connection?.close(4000, 'reviewer_sequence_gap')
            return
          }
          lastSequence = event.sequence

          const revision = numericRevision(event.revision)
          const key = `${event.resource.kind}:${event.resource.id}`
          const previous = revisions.get(key)
          if (revision !== null && previous !== undefined && revision <= previous) return
          if (revision !== null) revisions.set(key, revision)
          input.onEvent(event)
        },
        onError() { if (!stopped) input.onState('recovering') },
        onClose() {
          connection = null
          connecting = false
          if (!stopped) schedule()
        },
      })
    } catch {
      if (!stopped) schedule()
    } finally {
      connecting = false
    }
  }

  void connect()
  return { stop }
}

function numericRevision(value: string): bigint | null {
  try { return /^\d+$/.test(value) ? BigInt(value) : null }
  catch { return null }
}
