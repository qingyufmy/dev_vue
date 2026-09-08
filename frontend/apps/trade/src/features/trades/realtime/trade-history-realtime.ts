import type { TradeSessionSnapshot } from '~/features/auth'
import { createApiClient } from '@aurum/api-client'
import { browserRealtimeEventSchema } from '@aurum/contracts'

import { connectRealtime } from '@aurum/realtime'

export type TradeHistoryRealtimeState = 'idle' | 'connecting' | 'live' | 'recovering' | 'offline'

export function createTradeHistoryRealtime(input: { session: TradeSessionSnapshot; accountId: string; onState: (state: TradeHistoryRealtimeState) => void; onChanged: () => void; resync: () => Promise<unknown> }) {
  const client = createApiClient(); let stopped = false; let socket: ReturnType<typeof connectRealtime> | null = null; let timer: number | null = null; let attempts = 0
  const stop = () => { stopped = true; if (timer !== null) clearTimeout(timer); socket?.close(1000, 'trade_history_page_left'); input.onState('idle') }
  const retry = () => { if (stopped || timer !== null) return; input.onState('offline'); timer = window.setTimeout(() => { timer = null; if (!stopped) void input.resync().finally(connect) }, Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5))) }
  const connect = async () => {
    if (stopped) return
    input.onState('connecting')
    try { await client.createRealtimeTicket(input.session.csrf_token) } catch { retry(); return }
    if (stopped) return
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = connectRealtime({ url: `${scheme}//${location.host}/realtime/v4`, protocol: 'aurum.realtime.v4',
      onOpen(value) { value.send(JSON.stringify({ v: 4, type: 'subscription.subscribe', request_id: crypto.randomUUID(), targets: [{ kind: 'trades', trading_account_id: input.accountId, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'history', after_revision: null }] })) },
      onMessage(raw) { const type = typeof raw === 'object' && raw && 'type' in raw ? String(raw.type) : ''; if (type === 'subscription.ready') { attempts = 0; input.onState('live'); return }; const parsed = browserRealtimeEventSchema.safeParse(raw); if (parsed.success && parsed.data.type === 'trade.history.changed' && parsed.data.scope.trading_account_id === input.accountId) input.onChanged() },
      onError() { if (!stopped) input.onState('recovering') }, onClose() { socket = null; retry() },
    })
  }
  void connect(); return { stop }
}
