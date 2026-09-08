import { ref } from 'vue'
import type { MarketCandle, MarketQuote, OpenPosition, PendingOrder } from '@aurum/contracts'
import { applyAccountSnapshot } from '~/features/trading-context'
export { accountSnapshot, realtimeState } from '~/features/trading-context'

export const marketQuote = ref<MarketQuote | null>(null)
export const marketCandles = ref<MarketCandle[]>([])
export const openPositions = ref<OpenPosition[]>([])
export const pendingOrders = ref<PendingOrder[]>([])
export const resourceRevisions = ref({ account: 0, quote: 0, candle: 0, positions: 0, pendingOrders: 0 })


export function clearAccountRuntime() {
  applyAccountSnapshot(null)
  marketQuote.value = null
  marketCandles.value = []
  openPositions.value = []
  pendingOrders.value = []
  resourceRevisions.value = { account: 0, quote: 0, candle: 0, positions: 0, pendingOrders: 0 }
}
