import { createApiClient } from '@aurum/api-client'
import { inferenceRealtimeEventSchema } from '@aurum/contracts'
import type { InferenceRealtimeEvent, SessionSummary } from '@aurum/contracts'
import { connectRealtime } from '@aurum/realtime'

const client = createApiClient()
const delays = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export type AnalystRealtimeState = 'idle' | 'connecting' | 'live' | 'recovering' | 'offline'

export function createAnalystRealtime(input: {
  session: SessionSummary
  onState: (state: AnalystRealtimeState) => void
  onEvent: (event: InferenceRealtimeEvent) => void
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
    connection?.close(1000, 'analyst_page_left')
    connection = null
    input.onState('idle')
  }

  const schedule = () => {
    if (stopped || timer !== null) return
    input.onState('offline')
    const base = delays[Math.min(attempt, delays.length - 1)] ?? 30_000
    attempt += 1
    timer = window.setTimeout(() => {
      timer = null
      if (stopped) return
      input.onState('recovering')
      void input.resync().then(
        () => void connect(),
        () => schedule(),
      )
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
            targets: [{
              kind: 'signals', trading_account_id: null, observer_channel_id: null, symbol: null,
              timeframe: null, resource_id: 'all', after_revision: null,
            }],
          }))
        },
        onMessage(raw) {
          if (stopped) return
          const type = typeof raw === 'object' && raw !== null && 'type' in raw ? String(raw.type) : ''
          if (type === 'subscription.ready') {
            attempt = 0
            lastSequence = 0
            input.onState('live')
            return
          }
          if (type === 'subscription.resync_required') {
            input.onState('recovering')
            connection?.close(4000, 'analysis_resync_required')
            return
          }
          const parsed = inferenceRealtimeEventSchema.safeParse(raw)
          if (!parsed.success || parsed.data.scope.user_id !== input.session.user.id || parsed.data.scope.trading_account_id !== null) return
          const event = parsed.data
          if (lastSequence > 0 && event.sequence !== lastSequence + 1) {
            input.onState('recovering')
            connection?.close(4000, 'analysis_sequence_gap')
            return
          }
          lastSequence = event.sequence
          const revision = numericRevision(event.revision)
          const revisionKey = `${event.resource.kind}:${event.resource.id}`
          const previous = revisions.get(revisionKey)
          if (revision !== null && previous !== undefined && revision <= previous) return
          if (revision !== null) revisions.set(revisionKey, revision)
          input.onEvent(event)
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
