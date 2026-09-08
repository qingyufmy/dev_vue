import { connectRealtime } from '@aurum/realtime'
import { marketMacroRealtimeEventSchema } from '@aurum/contracts'

export function startMarketRealtime(input: {
  userId: string; url: string; ticket: () => Promise<unknown>; invalidate: () => void
  onState: (state: 'connecting' | 'live' | 'offline') => void
  connect?: typeof connectRealtime
}) {
  let stopped = false, generation = 0, attempt = 0
  let connection: ReturnType<typeof connectRealtime> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  function retry(current: number) {
    if (stopped || current !== generation || timer) return
    generation += 1
    clearTimeout(readyTimer); connection?.close(); connection = undefined
    input.onState('offline')
    timer = setTimeout(() => { timer = undefined; void start() }, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)))
  }
  async function start() {
    if (stopped) return
    const current = ++generation
    input.onState('connecting')
    const requestId = crypto.randomUUID()
    try {
      await input.ticket()
      if (stopped || current !== generation) return
      connection = (input.connect ?? connectRealtime)({ url: input.url, protocol: 'aurum.realtime.v4',
        onOpen(socket) {
          if (stopped || current !== generation) return
          socket.send(JSON.stringify({ v: 4, type: 'subscription.subscribe', request_id: requestId,
            targets: ['macro', 'calendar'].map(resource_id => ({ kind: 'market', resource_id, trading_account_id: null,
              observer_channel_id: null, symbol: null, timeframe: null, after_revision: null })) }))
        },
        onMessage(raw) {
          if (stopped || current !== generation) return
          if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'subscription.ready'
            && 'request_id' in raw && raw.request_id === requestId) {
            clearTimeout(readyTimer); attempt = 0; input.onState('live'); input.invalidate(); return
          }
          const event = marketMacroRealtimeEventSchema.safeParse(raw)
          if (event.success && event.data.scope.user_id === input.userId
            && event.data.type !== 'market.source_health.changed') input.invalidate()
        },
        onClose() { retry(current) }, onError() { retry(current) },
      })
      readyTimer = setTimeout(() => retry(current), 10000)
    } catch { retry(current) }
  }
  void start()
  return { stop() { stopped = true; generation += 1; clearTimeout(timer); clearTimeout(readyTimer); connection?.close(); connection = undefined } }
}
